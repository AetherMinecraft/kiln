import { describe, expect, it } from "vite-plus/test"
import type { RelayAuditRecord } from "@workspace/contracts"

import {
  activityLabelForAudit,
  activityPermissionForAudit,
  activityTypeForAudit,
  scopeAllowsAudit,
} from "@/lib/activity"

function audit(
  details: RelayAuditRecord["details"],
  event = "control.mutation"
): RelayAuditRecord {
  return {
    clientId: "hearth",
    details,
    event,
    id: "audit",
    occurredAt: 1,
    requestId: "request",
  }
}

describe("activity", () => {
  it("never exposes unknown or other-server scope to an instance-only user", () => {
    const scope = {
      relayAudit: false,
      allInstances: false,
      instanceIds: new Set(["server-a"]),
    }

    expect(scopeAllowsAudit(scope, audit({ operation: "relay.rename" }))).toBe(
      false
    )
    expect(
      scopeAllowsAudit(
        scope,
        audit({ instanceId: "server-b", operation: "instance.rename" })
      )
    ).toBe(false)
    expect(
      scopeAllowsAudit(
        scope,
        audit({ instanceId: "server-a", operation: "instance.rename" })
      )
    ).toBe(true)
  })

  it("classifies deployment activation and its managed-delete permission", () => {
    const record = audit({
      deletedFiles: 1,
      instanceId: "server-a",
      operation: "instance.files.sync.activate",
    })
    expect(activityTypeForAudit(record)).toBe("files")
    expect(activityLabelForAudit(record)).toBe(
      "Activated a server file deployment"
    )
    expect(activityPermissionForAudit(record)).toBe("instance.files.delete")
  })
})
