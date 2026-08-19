import { randomBytes } from "node:crypto"
import { lookup as dnsLookup } from "node:dns"
import {
  connect,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net"
import type { LookupFunction } from "node:net"

import { Effect, Result } from "effect"

import {
  isPublicRemoteAddress,
  secureRemoteLookup,
} from "./source-policy.js"

const MAX_CONNECT_HEADER_BYTES = 8_192
const AWS_SUFFIXES = [".amazonaws.com.cn", ".amazonaws.com"] as const

export type ResticS3ProxyOptions = {
  allowPrivateNetwork: boolean
  allowedHosts: ReadonlySet<string>
  endpointPort: number
  lookup?: LookupFunction
  token: string
}

export function resticS3ProxyToken(): string {
  return randomBytes(32).toString("base64url")
}

export function resticS3ProxyAllowedHosts(input: {
  bucket: string
  endpoint: string
  region: string
}): Set<string> {
  const endpointHost = canonicalizeHostname(new URL(input.endpoint).hostname)
  const hosts = new Set([endpointHost, `${input.bucket}.${endpointHost}`])
  const awsSuffix = AWS_SUFFIXES.find((suffix) => endpointHost.endsWith(suffix))
  if (!awsSuffix) return hosts
  const regional = `s3.${input.region}.${awsSuffix.slice(1)}`
  const dualstack = `s3.dualstack.${input.region}.${awsSuffix.slice(1)}`
  for (const host of [regional, dualstack]) {
    hosts.add(host)
    hosts.add(`${input.bucket}.${host}`)
  }
  return hosts
}

export function parseResticS3ConnectTarget(authority: string): {
  hostname: string
  port: number
} | null {
  if (
    authority.includes("/") ||
    authority.includes("?") ||
    authority.includes("#") ||
    authority.includes("@") ||
    authority.includes(" ")
  ) {
    return null
  }
  const parsed = parseAuthorityUrl(authority)
  if (!parsed) return null
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    return null
  }
  if (!parsed.port) return null
  const ipv6 = isIP(parsed.hostname.replace(/^\[|\]$/gu, "")) === 6
  if (ipv6 && !authority.startsWith("[")) return null
  const formatted = parsed.host
  const canonicalAuthority = canonicalizeConnectAuthority(authority)
  if (!canonicalAuthority || formatted !== canonicalAuthority) return null
  const hostname = canonicalizeHostname(parsed.hostname)
  const port = Number(parsed.port)
  if (!hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null
  }
  return { hostname, port }
}

export function parseResticS3ConnectRequest(
  raw: string,
  options: Pick<ResticS3ProxyOptions, "endpointPort" | "token">
): { hostname: string; port: number } | null {
  const [head, ...rest] = raw.split("\r\n")
  const requestLine = head?.split(" ")
  if (
    requestLine?.length !== 3 ||
    requestLine[0] !== "CONNECT" ||
    !requestLine[2]?.startsWith("HTTP/")
  ) {
    return null
  }
  const expected = Buffer.from(`user:${options.token}`).toString("base64")
  const authorized = rest.some((header) => {
    const separator = header.indexOf(":")
    if (separator === -1) return false
    const name = header.slice(0, separator).trim().toLowerCase()
    const value = header.slice(separator + 1).trim()
    return (
      name === "proxy-authorization" && value === `Basic ${expected}`
    )
  })
  if (!authorized) return null
  const target = parseResticS3ConnectTarget(requestLine[1] ?? "")
  if (!target || target.port !== options.endpointPort) return null
  return target
}

export function withResticS3Proxy<T>(
  options: ResticS3ProxyOptions,
  use: (proxyUrl: string) => Promise<T>
): Promise<T> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      listenResticS3Proxy(options),
      (server) =>
        Effect.tryPromise({
          try: () => use(resticS3ProxyUrl(server, options.token)),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error("The restic S3 proxy failed", { cause }),
        }),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
            })
        )
    )
  )
}

function listenResticS3Proxy(options: ResticS3ProxyOptions) {
  return Effect.tryPromise({
    try: () =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer((client) => {
          void handleConnectClient(client, options)
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject)
          resolve(server)
        })
      }),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error("The restic S3 proxy could not listen", { cause }),
  })
}

function resticS3ProxyUrl(server: Server, token: string): string {
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("The restic S3 proxy did not bind a local port")
  }
  return `http://user:${token}@127.0.0.1:${address.port}`
}

function handleConnectClient(
  client: Socket,
  options: ResticS3ProxyOptions
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () => readHttpHead(client),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("CONNECT headers failed", { cause }),
      })
      const target = parseResticS3ConnectRequest(raw, options)
      if (!target) {
        rejectConnect(client)
        return
      }
      if (!options.allowedHosts.has(target.hostname)) {
        console.error(
          `Rejected restic S3 CONNECT to disallowed host ${target.hostname}`
        )
        rejectConnect(client)
        return
      }
      const address = yield* Effect.promise(() =>
        resolveConnectAddress(target.hostname, options)
      )
      if (!address) {
        rejectConnect(client)
        return
      }
      const upstream = yield* Effect.tryPromise({
        try: () => connectUpstream(address, target.port),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Upstream CONNECT failed", { cause }),
      })
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      client.pipe(upstream)
      upstream.pipe(client)
      const close = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on("error", close)
      upstream.on("error", close)
      client.on("close", close)
      upstream.on("close", close)
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          rejectConnect(client)
        })
      )
    )
  )
}

function readHttpHead(client: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.byteLength > MAX_CONNECT_HEADER_BYTES) {
        cleanup()
        reject(new Error("CONNECT headers exceeded the maximum size"))
        return
      }
      const separator = buffer.indexOf("\r\n\r\n")
      if (separator === -1) return
      cleanup()
      resolve(buffer.subarray(0, separator).toString("latin1"))
    }
    const onEnd = () => {
      cleanup()
      reject(new Error("CONNECT headers ended before completion"))
    }
    const cleanup = () => {
      client.off("data", onData)
      client.off("end", onEnd)
      client.off("error", onEnd)
    }
    client.on("data", onData)
    client.on("end", onEnd)
    client.on("error", onEnd)
  })
}

function rejectConnect(client: Socket): void {
  client.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
  client.destroy()
}

function resolveConnectAddress(
  hostname: string,
  options: ResticS3ProxyOptions
): Promise<string | null> {
  const lookup = options.lookup ??
    (options.allowPrivateNetwork ? dnsLookup : secureRemoteLookup)
  return new Promise((resolve) => {
    lookup(
      hostname,
      { all: true, verbatim: true },
      (error, addresses) => {
        if (error || !Array.isArray(addresses) || addresses.length === 0) {
          if (error && !options.allowPrivateNetwork) {
            console.error(
              `Rejected restic S3 CONNECT to ${hostname}: ${error.message}`
            )
          }
          resolve(null)
          return
        }
        const selected = addresses.find((entry) => {
          if (options.allowPrivateNetwork) return true
          return isPublicRemoteAddress(entry.address)
        })
        if (!selected) {
          console.error(
            `Rejected restic S3 CONNECT to ${hostname}: private address`
          )
          resolve(null)
          return
        }
        resolve(selected.address)
      }
    )
  })
}

function connectUpstream(address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port })
    socket.once("error", reject)
    socket.once("connect", () => {
      socket.off("error", reject)
      resolve(socket)
    })
  })
}

function parseAuthorityUrl(authority: string): URL | null {
  return Result.getOrNull(Result.try(() => new URL(`http://${authority}`)))
}

function canonicalizeConnectAuthority(authority: string): string | null {
  const parsed = parseAuthorityUrl(authority.toLowerCase())
  if (!parsed?.port) return null
  const hostname = canonicalizeHostname(parsed.hostname)
  if (!hostname) return null
  const ipv6 = isIP(hostname) === 6
  return ipv6 ? `[${hostname}]:${parsed.port}` : `${hostname}:${parsed.port}`
}

function canonicalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "")
}
