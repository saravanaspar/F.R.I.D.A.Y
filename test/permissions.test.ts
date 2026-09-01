import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionApprovalRequest, PermissionRequest } from "../plugins/permissions/contract.js";
import { getPermissionsIdentitiesPath, getPermissionsStateDir } from "../plugins/permissions/identity-store.js";
import { createPermissionsController } from "../plugins/permissions/policy.js";

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-permissions-identities-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function request(
  workspace: string,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    mode: "ask",
    workspace,
    access: "read",
    action: {
      id: "test.workspace.read",
      effect: "workspace-read",
      resource: workspace,
      network: false,
    },
    reason: "test request",
    ...overrides,
  };
}

describe("action-aware permissions and trusted identities", () => {
  it("keeps trusted identity state under FRIDAY_HOME and ignores mission-state overrides", () => {
    expect(getPermissionsStateDir({
      FRIDAY_HOME: "/tmp/friday-home",
      FRIDAY_STATE_DIR: "/tmp/mission-state",
    })).toBe("/tmp/friday-home/permissions");
  });

  it("authorizes from host-owned action effects rather than reason prose", async () => {
    const workspace = await tempDir();
    const approvals: PermissionApprovalRequest[] = [];
    const controller = createPermissionsController({
      stateDir: join(workspace, "state"),
      approve: async (approval) => {
        approvals.push(approval);
        return true;
      },
    });

    await controller.trusted.runAsLocal(() => controller.permissions.authorize(request(workspace, {
      mode: "auto",
      access: "write",
      action: {
        id: "tools.edit.write",
        effect: "workspace-write",
        resource: workspace,
        network: false,
      },
      reason: "this prose claims the action is read-only",
    })));
    expect(approvals).toHaveLength(0);

    await controller.trusted.runAsLocal(() => controller.permissions.authorize(request(workspace, {
      mode: "auto",
      access: "write",
      action: {
        id: "vault.rotate",
        effect: "credential-write",
        resource: "vault://example",
        network: false,
      },
      reason: "harmless read only request",
    })));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      action: { id: "vault.rotate", effect: "credential-write" },
      principal: { id: "local:operator", kind: "local", role: "operator" },
    });

    await expect(controller.trusted.runAsLocal(() => controller.permissions.authorize(request(workspace, {
      mode: "full",
      access: "write",
      action: {
        id: "forged.read",
        effect: "workspace-read",
        resource: workspace,
        network: false,
      },
    })))).rejects.toThrow(/requires read access/);

    await expect(controller.trusted.runAsLocal(() => controller.permissions.authorize({
      ...request(workspace),
      mode: "unsafe" as never,
    }))).rejects.toThrow(/Expected ask, auto, or full/);
  });

  it("fails closed when privileged code forgets to establish a principal context", async () => {
    const workspace = await tempDir();
    const audit: Array<{ action: string; outcome: string }> = [];
    const controller = createPermissionsController({
      stateDir: join(workspace, "state"),
      audit: (entry) => audit.push({ action: entry.action, outcome: entry.outcome }),
    });

    await expect(controller.permissions.authorize(request(workspace, { mode: "full" }))).rejects.toThrow(
      /Permission context is required/,
    );
    expect(audit).toContainEqual({ action: "permissions.missing-context", outcome: "denied" });
  });

  it("fails closed for unregistered channel identities and enforces read-only roles even in full mode", async () => {
    const workspace = await tempDir();
    const stateDir = join(workspace, "permissions-state");
    const controller = createPermissionsController({ stateDir, approve: async () => true });
    const selector = { channel: "telegram", accountId: "default", senderId: "user-123" };

    expect(() => controller.trusted.runAsChannel(selector, () => undefined)).toThrow(/not trusted/i);

    const identity = controller.trusted.runAsLocal(() => controller.trusted.trustChannelIdentity({
      ...selector,
      role: "read-only",
      label: "Read-only operator",
    }));
    expect(identity.role).toBe("read-only");

    await expect(controller.trusted.runAsChannel(selector, () => controller.permissions.authorize(request(workspace, {
      mode: "full",
      access: "read",
    })))).resolves.toEqual({ allowed: true, approvedBy: "policy" });

    await expect(controller.trusted.runAsChannel(selector, () => controller.permissions.authorize(request(workspace, {
      mode: "full",
      access: "read",
      action: {
        id: "system.actions",
        effect: "public-read",
        resource: "system:actions",
        network: false,
      },
    })))).resolves.toEqual({ allowed: true, approvedBy: "policy" });

    await expect(controller.trusted.runAsChannel(selector, () => controller.permissions.authorize(request(workspace, {
      mode: "full",
      access: "read",
      action: {
        id: "sessions.private.read",
        effect: "private-read",
        resource: "sessions:owned",
        network: false,
      },
    })))).resolves.toEqual({ allowed: true, approvedBy: "policy" });

    await expect(controller.trusted.runAsChannel(selector, () => controller.permissions.authorize(request(workspace, {
      mode: "full",
      access: "read",
      action: {
        id: "audit.global.read",
        effect: "global-operational-read",
        resource: "audit:global",
        network: false,
      },
    })))).rejects.toThrow(/read-only/);

    const forgedPrincipal = {
      id: "local:operator",
      kind: "local",
      role: "operator",
      label: "forged",
    };
    await expect(controller.trusted.runAsChannel(selector, () => controller.permissions.authorize({
      ...request(workspace, {
        mode: "full",
        access: "write",
        action: {
          id: "mcp.call-tool",
          effect: "external-write",
          resource: "linear:create_issue",
          network: true,
        },
      }),
      principal: forgedPrincipal,
    } as PermissionRequest))).rejects.toThrow(/read-only/);
  });

  it("persists trusted channel identities privately and isolates concurrent async principals", async () => {
    const workspace = await tempDir();
    const stateDir = join(workspace, "permissions-state");
    const first = createPermissionsController({ stateDir, approve: async () => true });
    const alice = { channel: "slack", accountId: "work", senderId: "U-ALICE" };
    const bob = { channel: "slack", accountId: "work", senderId: "U-BOB" };
    first.trusted.runAsLocal(() => {
      first.trusted.trustChannelIdentity({ ...alice, role: "operator", label: "Alice" });
      first.trusted.trustChannelIdentity({ ...bob, role: "operator", label: "Bob" });
    });

    const identityPath = getPermissionsIdentitiesPath(stateDir);
    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);

    const approvals: PermissionApprovalRequest[] = [];
    const reopened = createPermissionsController({
      stateDir,
      approve: async (approval) => {
        await new Promise((resolve) => setTimeout(resolve, approval.principal.senderId === "U-ALICE" ? 5 : 0));
        approvals.push(approval);
        return true;
      },
    });
    expect(reopened.trusted.identities().map((identity) => identity.label).sort()).toEqual(["Alice", "Bob"]);

    const externalRead = (resource: string): Partial<PermissionRequest> => ({
      mode: "ask",
      action: {
        id: "mcp.list-tools",
        effect: "external-read",
        resource,
        network: true,
      },
    });
    await Promise.all([
      reopened.trusted.runAsChannel(alice, () => reopened.permissions.authorize(request(workspace, externalRead("linear")))),
      reopened.trusted.runAsChannel(bob, () => reopened.permissions.authorize(request(workspace, externalRead("notion")))),
    ]);
    expect(new Set(approvals.map((approval) => approval.principal.senderId))).toEqual(new Set(["U-ALICE", "U-BOB"]));
  });

  it("fails closed on corrupt trusted identity state", async () => {
    const workspace = await tempDir();
    const stateDir = join(workspace, "permissions-state");
    const controller = createPermissionsController({ stateDir, approve: async () => true });
    controller.trusted.runAsLocal(() => {
      controller.trusted.trustChannelIdentity({ channel: "discord", accountId: "bot", senderId: "123" });
    });
    const path = getPermissionsIdentitiesPath(stateDir);
    await chmod(path, 0o600);
    await writeFile(path, "{broken\n", { mode: 0o600 });

    expect(() => controller.trusted.identities()).toThrow(/Unable to parse trusted identity state/);
    expect(() => controller.trusted.runAsChannel(
      { channel: "discord", accountId: "bot", senderId: "123" },
      () => undefined,
    )).toThrow(/Unable to parse trusted identity state/);
  });
});
