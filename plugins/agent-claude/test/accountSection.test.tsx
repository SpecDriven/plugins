// Settings → Claude's "Claude account" (specs/agents/claude.feature.md "Sign
// in to Claude with an email"): plainly who is signed in or that nobody is,
// "Sign in" with the email field while nobody is, "Check sign-in" and
// "Sign out" once someone is — and no "Switch account": another account
// takes a sign-out first.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountModel } from "../src/accountModels";
import { ClaudeAccount, signInCheckText, type ClaudeAuthInfo } from "../src/ui/ClaudeSettings";

const info = (login: ClaudeAuthInfo["login"], extra: Partial<ClaudeAuthInfo> = {}) =>
  ({ mode: "login", cliAvailable: true, canFetchClaude: false, login, signIn: null, ...extra }) as ClaudeAuthInfo;
const html = (login: ClaudeAuthInfo["login"], extra: Partial<ClaudeAuthInfo> = {}) =>
  renderToStaticMarkup(
    <ClaudeAccount info={info(login, extra)} onChange={() => {}} refresh={async () => {}} reloadModels={() => {}} onModels={() => {}} />,
  );
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

test("signed out, the section says so plainly and offers Sign in with the email field, and a check", () => {
  const out = html({ loggedIn: false, method: "none", email: null });
  expect(out).toContain("<strong>Not signed in.</strong> Enter the email of your Claude account");
  expect(out).toContain('aria-label="Claude account email"');
  expect(buttons(out)).toEqual(["Sign in", "Check sign-in"]);
  expect(out).not.toContain("Switch account");
});

test("signed in, the section names the account and offers Check sign-in and Sign out — no email field, no Switch account", () => {
  const out = html({ loggedIn: true, method: "claude.ai", email: "ada@example.com" });
  expect(out).toContain("Signed in as <strong>ada@example.com</strong>.");
  expect(out).not.toContain('aria-label="Claude account email"');
  expect(buttons(out)).toEqual(["Check sign-in", "Sign out"]);
  expect(out).not.toContain("Switch account");
  // A token in the environment is a sign-in too, with no account to name.
  expect(html({ loggedIn: true, method: "oauth_token", email: null })).toContain("Signed in with a token Claude Code found in its environment.");
});

test("an API key is not an account: the section says so and asks for a sign-in", () => {
  const out = html({ loggedIn: true, method: "api_key", email: null });
  expect(out).toContain("<strong>Signed in with an API key, not a Claude account</strong>");
  expect(buttons(out)).toEqual(["Sign in", "Check sign-in"]);
});

test("with no Claude Code and none to fetch, there is nothing to sign in with", () => {
  const out = html({ loggedIn: false, method: "missing", email: null }, { cliAvailable: false, canFetchClaude: false });
  expect(out).toContain("install the claude command");
  expect(buttons(out)).toEqual([]);
});

test("the check's finding is one sentence: the account, and whether Claude Code lists its models", () => {
  const ada = { loggedIn: true, method: "claude.ai", email: "ada@example.com" };
  const models: AccountModel[] = [
    { value: "opus", displayName: "Opus", description: "" },
    { value: "sonnet", displayName: "Sonnet", description: "" },
  ];
  expect(signInCheckText(ada, models, null)).toBe("Signed in as ada@example.com — Claude Code started under the account and lists 2 models.");
  expect(signInCheckText(ada, models.slice(0, 1), null)).toContain("lists 1 model.");
  expect(signInCheckText(ada, [], null)).toBe("Signed in as ada@example.com, but Claude Code listed no models for the account.");
  expect(signInCheckText(ada, [], "Claude Code exited")).toBe(
    "Signed in as ada@example.com, but Claude Code could not list the account's models: Claude Code exited",
  );
  expect(signInCheckText({ loggedIn: false, method: "none", email: null }, [], null)).toBe(
    "Not signed in — the Claude CLI has no account. Sign in below.",
  );
  expect(signInCheckText({ loggedIn: true, method: "api_key", email: null }, [], null)).toContain("API key");
  // What the Claude Code started under the account found comes first: no
  // account, token or key is "Not signed in", whatever the CLI said.
  const nobody = { billing: "none", label: "Not logged in", detail: "" } as const;
  expect(signInCheckText(ada, [], null, nobody)).toBe(
    "Not signed in — the Claude Code started under the account found no account, token or key. Sign in below.",
  );
  expect(signInCheckText(ada, models, null, { billing: "plan", label: "Claude Max", detail: "" })).toContain("lists 2 models.");
});

test("a code handed to the CLI shows as being checked, and one it refused shows the CLI's words under the field", () => {
  const nobody = { loggedIn: false, method: "none", email: null };
  const signIn = (extra: Partial<NonNullable<ClaudeAuthInfo["signIn"]>>) =>
    ({ inProgress: true, email: "ada@example.com", url: "https://claude.com/cai/oauth/authorize", download: null, acceptsCode: true, done: false, error: null, ...extra }) as ClaudeAuthInfo["signIn"];

  const waiting = html(nobody, { signIn: signIn({ codeSent: true, codeError: null }) });
  expect(buttons(waiting)).toEqual(["Finishing…", "Cancel"]);
  expect(waiting).toContain("Code sent — waiting for Claude Code to finish the sign-in with it…");
  expect(waiting).toMatch(/<input[^>]*aria-label="Code from the sign-in page"[^>]*disabled/);

  const refused = html(nobody, { signIn: signIn({ codeSent: false, codeError: "Invalid code. Please make sure the full code was copied." }) });
  expect(buttons(refused)).toEqual(["Finish sign-in", "Cancel"]);
  expect(refused).toContain('<p class="error" role="alert">Claude Code refused that code: Invalid code. Please make sure the full code was copied.');
  expect(refused).not.toContain("Code sent");

  // A plugin host from before the two fields: the field and button as they were.
  const before = html(nobody, { signIn: signIn({}) });
  expect(buttons(before)).toEqual(["Finish sign-in", "Cancel"]);
  expect(before).not.toContain("refused that code");
});
