import { describe, expect, it } from "vite-plus/test"

import {
  instancePortsWritePermission,
  platformRoleHasPermission,
  roleHasPermission,
} from "@/lib/permissions"

describe("platform appearance permissions", () => {
  it("reserves appearance defaults for platform administrators", () => {
    expect(
      platformRoleHasPermission("admin", "platform.appearance.manage-default")
    ).toBe(true)
    expect(
      platformRoleHasPermission("user", "platform.appearance.manage-default")
    ).toBe(false)
  })
})

describe("server deletion permissions", () => {
  it("allows owners and administrators to delete servers", () => {
    expect(roleHasPermission("owner", "instance.delete")).toBe(true)
    expect(roleHasPermission("admin", "instance.delete")).toBe(true)
  })

  it("does not allow operators or viewers to delete servers", () => {
    expect(roleHasPermission("operator", "instance.delete")).toBe(false)
    expect(roleHasPermission("viewer", "instance.delete")).toBe(false)
  })
})

describe("managed deployment deletion permissions", () => {
  it("allows non-viewer roles to delete explicitly managed files", () => {
    expect(roleHasPermission("owner", "instance.files.delete-managed")).toBe(
      true
    )
    expect(roleHasPermission("admin", "instance.files.delete-managed")).toBe(
      true
    )
    expect(roleHasPermission("operator", "instance.files.delete-managed")).toBe(
      true
    )
    expect(roleHasPermission("viewer", "instance.files.delete-managed")).toBe(
      false
    )
  })
})

describe("public port permissions", () => {
  it("reserves public port range overrides for platform administrators", () => {
    expect(
      platformRoleHasPermission(
        "admin",
        "platform.network.override-public-port-range"
      )
    ).toBe(true)
    expect(
      platformRoleHasPermission(
        "user",
        "platform.network.override-public-port-range"
      )
    ).toBe(false)
  })

  it("limits public port changes to owners and administrators", () => {
    expect(
      roleHasPermission("owner", "instance.network.public-port.write")
    ).toBe(true)
    expect(
      roleHasPermission("admin", "instance.network.public-port.write")
    ).toBe(true)
    expect(
      roleHasPermission("operator", "instance.network.public-port.write")
    ).toBe(false)
    expect(
      roleHasPermission("viewer", "instance.network.public-port.write")
    ).toBe(false)
  })

  it("protects replacements without blocking new allocations", () => {
    expect(
      instancePortsWritePermission([{ externalPort: 32_124, id: "primary" }])
    ).toBe("instance.network.public-port.write")
    expect(
      instancePortsWritePermission([
        { externalPort: 32_124, id: "custom-allocation" },
      ])
    ).toBe("instance.network.public-port.write")
    expect(instancePortsWritePermission([{ externalPort: 32_124 }])).toBe(
      "instance.network.write"
    )
    expect(instancePortsWritePermission([{ id: "primary" }])).toBe(
      "instance.network.write"
    )
  })
})

describe("backup permissions", () => {
  it("allows operators to manage backups without granting server deletion", () => {
    expect(roleHasPermission("operator", "backup.create")).toBe(true)
    expect(roleHasPermission("operator", "backup.restore")).toBe(true)
    expect(roleHasPermission("operator", "backup.delete")).toBe(true)
    expect(roleHasPermission("operator", "instance.delete")).toBe(false)
  })

  it("limits viewers to reading and downloading existing backups", () => {
    expect(roleHasPermission("viewer", "backup.read")).toBe(true)
    expect(roleHasPermission("viewer", "backup.download")).toBe(true)
    expect(roleHasPermission("viewer", "backup.create")).toBe(false)
    expect(roleHasPermission("viewer", "backup.restore")).toBe(false)
    expect(roleHasPermission("viewer", "backup.delete")).toBe(false)
  })

  it("reserves platform destinations and caps for platform administrators", () => {
    expect(
      platformRoleHasPermission("admin", "platform.backups.manage-storage")
    ).toBe(true)
    expect(
      platformRoleHasPermission("admin", "platform.backups.manage-limits")
    ).toBe(true)
    expect(
      platformRoleHasPermission("user", "platform.backups.manage-storage")
    ).toBe(false)
    expect(
      platformRoleHasPermission("user", "platform.backups.manage-limits")
    ).toBe(false)
  })
})
