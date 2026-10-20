import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkspace, parseSnapshot, snapshotWorkspace, type BuildDeps, type WorkspaceSnapshot } from "../src/workspace.ts";
import type { Layout, Tab, TermSession } from "../src/stores/terminals.ts";
import type { TerminalTarget } from "../src/api.ts";

function sess(id: string, tabId: string, patch: Partial<TermSession> = {}): TermSession {
  return {
    id,
    tabId,
    target: { kind: "local", cwd: null },
    title: "本地终端",
    subtitle: "",
    status: "running",
    exitCode: null,
    error: null,
    backendId: `b-${id}`,
    hostId: null,
    generation: 3,
    ...patch,
  };
}

/** 一个有代表性的工作区：改过名的分屏标签 + 文件标签 + 主机已删掉的 SSH 标签 */
function fixture(): { tabs: Tab[]; sessions: TermSession[] } {
  const sessions = [
    sess("s1", "t1", {
      cwd: "/Users/liubao/AI/deepevidence",
      subtitle: "devin: DF 接入 DE web 独立入口方案设计",
      themeId: "dracula",
      title: "DE 审查",
    }),
    sess("s2", "t1", {
      target: { kind: "ssh", alias: "prod", command: "sudo reboot" },
      title: "prod",
      hostId: "prod",
      initialInput: "rm -rf /tmp/x\r",
      status: "connecting",
    }),
    sess("s3", "t1", { target: { kind: "local", cwd: "/tmp" }, status: "exited" }),
    sess("s4", "t3", { target: { kind: "ssh", alias: "gone" }, title: "gone", hostId: "gone" }),
  ];
  const t1Layout: Layout = {
    type: "split",
    id: "p1",
    dir: "row",
    ratio: 0.6,
    a: { type: "leaf", sessionId: "s1" },
    b: {
      type: "split",
      id: "p2",
      dir: "col",
      ratio: 0.3,
      a: { type: "leaf", sessionId: "s2" },
      b: { type: "leaf", sessionId: "s3" },
    },
  };
  const tabs: Tab[] = [
    { id: "t1", kind: "terminal", title: "DE 审查", hostId: null, layout: t1Layout, activeSessionId: "s2" },
    { id: "t2", kind: "files", title: "prod · 文件", hostId: "prod", layout: null, activeSessionId: null },
    { id: "t3", kind: "terminal", title: "gone", hostId: "gone", layout: { type: "leaf", sessionId: "s4" }, activeSessionId: "s4" },
  ];
  return { tabs, sessions };
}

function deps(over: Partial<BuildDeps> = {}): BuildDeps {
  let n = 0;
  const known = new Set(["prod"]);
  return {
    newId: (p) => `${p}x${++n}`,
    makeSession: (tabId: string, target: TerminalTarget, title: string, hostId: string | null): TermSession => ({
      ...sess(`sx${++n}`, tabId, { target, title, hostId, status: "connecting", backendId: null, generation: 0 }),
    }),
    resolveHostId: (id, alias) => (alias && known.has(alias) ? alias : id && known.has(id) ? id : null),
    wakeActive: true,
    ...over,
  };
}

test("快照只存可恢复的东西：去掉 SSH 附带命令和自动输入，本地终端用最新目录，记下程序标题和面板配色", () => {
  const { tabs, sessions } = fixture();
  const snap = snapshotWorkspace(tabs, sessions, "t1");
  const expected: WorkspaceSnapshot = {
    v: 1,
    active: 0,
    tabs: [
      {
        kind: "terminal",
        title: "DE 审查",
        hostId: null,
        active: 1,
        sessions: [
          {
            target: { kind: "local", cwd: "/Users/liubao/AI/deepevidence" },
            title: "DE 审查",
            hostId: null,
            themeId: "dracula",
            lastTitle: "devin: DF 接入 DE web 独立入口方案设计",
          },
          { target: { kind: "ssh", alias: "prod" }, title: "prod", hostId: "prod" },
          { target: { kind: "local", cwd: "/tmp" }, title: "本地终端", hostId: null },
        ],
        layout: {
          type: "split",
          dir: "row",
          ratio: 0.6,
          a: { type: "leaf", session: 0 },
          b: { type: "split", dir: "col", ratio: 0.3, a: { type: "leaf", session: 1 }, b: { type: "leaf", session: 2 } },
        },
      },
      { kind: "files", title: "prod · 文件", hostId: "prod", active: 0, sessions: [], layout: null },
      {
        kind: "terminal",
        title: "gone",
        hostId: "gone",
        active: 0,
        sessions: [{ target: { kind: "ssh", alias: "gone" }, title: "gone", hostId: "gone" }],
        layout: { type: "leaf", session: 0 },
      },
    ],
  };
  assert.deepEqual(snap, expected);
  assert.equal(JSON.stringify(snap).includes("reboot"), false);
  assert.equal(JSON.stringify(snap).includes("rm -rf"), false);
  assert.deepEqual(parseSnapshot(JSON.stringify(snap)), snap, "JSON 往返不变");
});

test("恢复：上次停留的标签立即连接，其余标签延迟；布局、比例、标题、配色、目录原样，id 全部新生成", () => {
  const { tabs, sessions } = fixture();
  const snap = parseSnapshot(JSON.stringify(snapshotWorkspace(tabs, sessions, "t1")))!;
  const r = buildWorkspace(snap, deps());
  assert.equal(r.tabs.length, 3);
  const [t1, t2, t3] = r.tabs;
  assert.equal(r.activeId, t1.id);
  assert.equal(t1.deferred, false);
  assert.equal(t2.deferred, true);
  assert.equal(t3.deferred, true);
  assert.equal(t1.title, "DE 审查");

  const t1s = r.sessions.filter((s) => s.tabId === t1.id);
  assert.equal(t1s.length, 3);
  assert.deepEqual(t1s.map((s) => s.status), ["connecting", "connecting", "connecting"]);
  assert.deepEqual(t1s[0].target, { kind: "local", cwd: "/Users/liubao/AI/deepevidence" });
  assert.equal(t1s[0].cwd, "/Users/liubao/AI/deepevidence");
  assert.equal(t1s[0].themeId, "dracula");
  assert.equal(t1s[0].lastTitle, "devin: DF 接入 DE web 独立入口方案设计");
  assert.equal(t1s[0].restored, true);
  assert.deepEqual(t1s[1].target, { kind: "ssh", alias: "prod" }, "不带附带命令");
  assert.equal(t1s[1].initialInput, undefined, "不重放自动输入");
  assert.equal(t1s[1].hostId, "prod");
  assert.equal(t1.activeSessionId, t1s[1].id);

  const lay = t1.layout!;
  assert.equal(lay.type, "split");
  if (lay.type !== "split" || lay.b.type !== "split") throw new Error("布局形状不对");
  assert.equal(lay.dir, "row");
  assert.equal(lay.ratio, 0.6);
  assert.deepEqual(lay.a, { type: "leaf", sessionId: t1s[0].id });
  assert.equal(lay.b.dir, "col");
  assert.equal(lay.b.ratio, 0.3);
  assert.deepEqual([lay.b.a, lay.b.b], [{ type: "leaf", sessionId: t1s[1].id }, { type: "leaf", sessionId: t1s[2].id }]);
  assert.notEqual(lay.id, lay.b.id);

  assert.equal(t2.kind, "files");
  assert.equal(t2.hostId, "prod");

  const [s4] = r.sessions.filter((s) => s.tabId === t3.id);
  assert.equal(s4.status, "idle", "延迟标签里的面板先不连接");
  assert.equal(s4.hostId, null, "主机已删掉：照常恢复，不挂旧主机");
  assert.equal(t3.hostId, null);

  const ids = [...r.tabs.map((t) => t.id), ...r.sessions.map((s) => s.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.some((id) => ["t1", "t2", "t3", "s1", "s2", "s3", "s4"].includes(id)), false);
});

test("已经有标签开着（wakeActive=false）或上次停在首页：恢复的标签全部延迟、不抢当前标签", () => {
  const { tabs, sessions } = fixture();
  for (const [snap, wake] of [
    [snapshotWorkspace(tabs, sessions, "t1"), false],
    [snapshotWorkspace(tabs, sessions, null), true],
  ] as const) {
    const r = buildWorkspace(snap, deps({ wakeActive: wake }));
    assert.equal(r.activeId, null);
    assert.equal(r.tabs.every((t) => t.deferred), true);
    assert.equal(r.sessions.every((s) => s.status === "idle"), true);
  }
});

test("主机已删掉的文件标签丢弃，当前标签下标跟着前移", () => {
  const snap: WorkspaceSnapshot = {
    v: 1,
    active: 1,
    tabs: [
      { kind: "files", title: "gone · 文件", hostId: "gone", active: 0, sessions: [], layout: null },
      {
        kind: "terminal",
        title: "本地终端",
        hostId: null,
        active: 0,
        sessions: [{ target: { kind: "local", cwd: null }, title: "本地终端", hostId: null }],
        layout: { type: "leaf", session: 0 },
      },
    ],
  };
  const r = buildWorkspace(snap, deps());
  assert.equal(r.tabs.length, 1);
  assert.equal(r.activeId, r.tabs[0].id);
  assert.equal(r.tabs[0].deferred, false);
});

test("存档损坏 / 版本不认识 → null；单个坏标签丢掉、其余保留，下标重新对应", () => {
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot("{oops"), null);
  assert.equal(parseSnapshot('{"v":2,"tabs":[],"active":null}'), null);
  assert.equal(parseSnapshot('{"v":1,"tabs":{},"active":null}'), null);

  const good = {
    kind: "terminal",
    title: "ok",
    hostId: null,
    active: 0,
    sessions: [{ target: { kind: "local", cwd: "/tmp" }, title: "ok", hostId: null }],
    layout: { type: "leaf", session: 0 },
  };
  const bad = [
    { ...good, layout: { type: "leaf", session: 1 } },
    { ...good, sessions: [...good.sessions, good.sessions[0]], layout: { type: "split", dir: "row", ratio: 0.5, a: { type: "leaf", session: 0 }, b: { type: "leaf", session: 0 } } },
    { ...good, sessions: [...good.sessions, good.sessions[0]] },
    { ...good, layout: { type: "split", dir: "diag", ratio: 0.5, a: { type: "leaf", session: 0 }, b: { type: "leaf", session: 0 } } },
    { ...good, sessions: [{ target: { kind: "ssh", alias: "" }, title: "x", hostId: null }] },
    { ...good, sessions: [{ target: { kind: "telnet" }, title: "x", hostId: null }] },
    { ...good, title: 42 },
    { kind: "files", title: "f", hostId: null, active: 0, sessions: [], layout: null },
    "nope",
  ];
  const snap = parseSnapshot(JSON.stringify({ v: 1, active: bad.length + 1, tabs: [...bad, good, { ...good, title: "ok2" }] }))!;
  assert.deepEqual(snap.tabs.map((t) => t.title), ["ok", "ok2"]);
  assert.equal(snap.active, 1);
  const dropped = parseSnapshot(JSON.stringify({ v: 1, active: 0, tabs: [bad[0], good] }))!;
  assert.equal(dropped.active, null, "当前标签被丢掉 → 停在首页");
});

test("比例夹到 0.15–0.85，聚焦面板下标越界回到 0，程序标题去掉控制字符并截断", () => {
  const snap = parseSnapshot(
    JSON.stringify({
      v: 1,
      active: 0,
      tabs: [
        {
          kind: "terminal",
          title: "t",
          hostId: null,
          active: 9,
          sessions: [
            { target: { kind: "local", cwd: null }, title: "a", hostId: null, lastTitle: `x\x1b[31m\x07y${"长".repeat(300)}` },
            { target: { kind: "local", cwd: null }, title: "b", hostId: null },
          ],
          layout: { type: "split", dir: "row", ratio: 3, a: { type: "leaf", session: 0 }, b: { type: "leaf", session: 1 } },
        },
      ],
    }),
  )!;
  const t = snap.tabs[0];
  assert.equal(t.active, 0);
  assert.equal(t.layout?.type === "split" && t.layout.ratio, 0.85);
  const lt = t.sessions[0].lastTitle!;
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(lt), false);
  assert.ok(lt.startsWith("x[31my长"));
  assert.ok(lt.length <= 120);
});

test("快照：程序标题为空时沿用上次带过来的标题；停在首页时 active 为 null；没内容的标签跳过", () => {
  const s = sess("s1", "t1", { subtitle: "", lastTitle: "devin: 医学资产分支\x1b" });
  const tabs: Tab[] = [
    { id: "t1", kind: "terminal", title: "x", hostId: null, layout: { type: "leaf", sessionId: "s1" }, activeSessionId: "s1" },
    { id: "t2", kind: "terminal", title: "empty", hostId: null, layout: null, activeSessionId: null },
    { id: "t3", kind: "files", title: "no host", hostId: null, layout: null, activeSessionId: null },
  ];
  const snap = snapshotWorkspace(tabs, [s], null);
  assert.equal(snap.active, null);
  assert.equal(snap.tabs.length, 1);
  assert.equal(snap.tabs[0].sessions[0].lastTitle, "devin: 医学资产分支");
});
