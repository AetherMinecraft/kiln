import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const legacySource = "https://github.com/kiln-site/hearth"

test("workflows publish images for the repository running them", async () => {
  const [
    reusableImage,
    images,
    embers,
    nightlyRelease,
    hearthDockerfile,
    relayDockerfile,
  ] = await Promise.all([
    readFile(".github/workflows/reusable-image.yml", "utf8"),
    readFile(".github/workflows/images.yml", "utf8"),
    readFile(".github/workflows/embers.yml", "utf8"),
    readFile(".github/workflows/nightly-release.yml", "utf8"),
    readFile("apps/web/Dockerfile", "utf8"),
    readFile("apps/relay/Dockerfile", "utf8"),
  ])

  assert.match(
    reusableImage,
    /labels: \|\r?\n\s+\$\{\{ inputs\.source_label && format\('org\.opencontainers\.image\.source=\{0\}', inputs\.source_label\) \|\| '' \}\}/u
  )
  assert.equal(countDynamicSourceLabels(images), 1)
  assert.equal(countDynamicSourceLabels(embers), 2)
  assert.equal(countDynamicSourceLabels(nightlyRelease), 3)
  assert.doesNotMatch(
    [reusableImage, images, embers, nightlyRelease].join("\n"),
    /ghcr\.io\/kiln-site/u
  )
  assert.match(hearthDockerfile, dockerfileSourceLabel())
  assert.match(relayDockerfile, dockerfileSourceLabel())
})

function countDynamicSourceLabels(workflow) {
  return workflow.split(
    "source_label: ${{ github.server_url }}/${{ github.repository }}"
  ).length - 1
}

function dockerfileSourceLabel() {
  return new RegExp(
    `LABEL org\\.opencontainers\\.image\\.source="${legacySource}"`,
    "u"
  )
}
