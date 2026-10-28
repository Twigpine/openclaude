import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIssueReport,
  formatIssueReportAsMarkdown,
  parseIssueReportArgs,
  writeIssueReport,
} from "./issueReport.js";

const baseEnv = {
  HOME: "/home/alice",
  PATH: "/usr/bin",
  CLAUDE_CODE_USE_OPENAI: "1",
  OPENAI_API_KEY: "sk-openai-secret",
  OPENAI_BASE_URL:
    "https://user:pass@api.openai.com/v1?api_key=secret&mode=test",
  OPENAI_MODEL: "gpt-5.5",
};

describe("diagnostic issue report", () => {
  test("builds a safe JSON report without secrets or full home paths", async () => {
    const report = await buildIssueReport({
      env: baseEnv,
      cwd: "/home/alice/private/openclaude",
      now: new Date("2026-06-15T10:30:00.000Z"),
      packageInfo: {
        version: "0.18.0",
        displayVersion: "0.18.0-test",
      },
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: ["userSettings", "projectSettings"],
        validationErrors: [],
      },
      mcpServers: {
        alpha: { type: "stdio", command: "node", args: ["server.js"] },
        beta: { type: "http", url: "https://mcp.example.test" },
      },
      errors: [
        {
          error:
            "Error: request failed with sk-openai-secret at /home/alice/private/openclaude/src/file.ts",
          timestamp: "2026-06-15T10:00:00.000Z",
        },
      ],
    });

    const serialized = JSON.stringify(report);
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe("2026-06-15T10:30:00.000Z");
    expect(report.openclaude.version).toBe("0.18.0");
    expect(report.workspace.cwd).toBe("openclaude");
    expect(report.provider.routeId).toBe("openai");
    expect(report.provider.credential.present).toBe(true);
    expect(report.provider.credential.sources).toEqual(["OPENAI_API_KEY"]);
    expect(report.provider.baseUrl).toBe(
      "https://api.openai.com/v1?api_key=redacted&mode=test",
    );
    expect(serialized).not.toMatch(/\/\/[^/]*@/);
    expect(report.mcp.transports).toEqual({ stdio: 1, http: 1 });
    expect(report.errors.recent).toEqual([{ category: "Error", count: 1 }]);
    expect(report.redaction.secretsIncluded).toBe(false);
    expect(serialized).not.toContain("sk-openai-secret");
    expect(serialized).not.toContain("/home/alice");
    expect(serialized).not.toContain("server.js");
  });

  test("does not report delimiter-only OpenAI credential pools as present", async () => {
    const report = await buildIssueReport({
      env: {
        ...baseEnv,
        OPENAI_API_KEYS: ", ,",
        OPENAI_API_KEY: undefined,
      },
      cwd: "/home/alice/private/openclaude",
      now: new Date("2026-06-15T10:30:00.000Z"),
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: [],
        validationErrors: [],
      },
      mcpServers: {},
      errors: [],
    });

    expect(report.provider.credential.present).toBe(false);
    expect(report.provider.credential.sources).toEqual([]);
  });

  test("formats markdown suitable for a GitHub issue", async () => {
    const report = await buildIssueReport({
      env: baseEnv,
      cwd: "/home/alice/private/openclaude",
      now: new Date("2026-06-15T10:30:00.000Z"),
      packageInfo: { version: "0.18.0" },
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: ["userSettings"],
        validationErrors: [],
      },
      mcpServers: {},
      errors: [],
    });

    report.checks = [{
      label: "Path",
      ok: true,
      detail: String.raw`C:\tools\bin | next\|cell`,
    }];
    const markdown = formatIssueReportAsMarkdown(report);
    const html = marked.parse(markdown) as string;
    expect(html).toContain(String.raw`<td>C:\tools\bin | next\|cell</td>`);

    expect(markdown).toContain("# OpenClaude diagnostic report");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("| Check | Status | Detail |");
    expect(markdown).toContain(
      "This report is redacted. It should not contain API keys, prompts, transcripts, or file contents.",
    );
    expect(markdown).not.toContain("sk-openai-secret");
    expect(markdown).not.toContain("/home/alice");
  });

  test("falls back safely when build macros are absent in source tests", async () => {
    const originalMacro = (globalThis as Record<string, unknown>).MACRO;
    const hadMacro = Object.hasOwn(globalThis, "MACRO");
    delete (globalThis as Record<string, unknown>).MACRO;

    try {
      const report = await buildIssueReport({
        env: baseEnv,
        cwd: "/home/alice/private/openclaude",
        now: new Date("2026-06-15T10:30:00.000Z"),
        checks: {
          buildArtifactsPresent: true,
          ripgrep: { available: true, detail: "system rg" },
        },
        settings: {
          sourcesPresent: [],
          validationErrors: [],
        },
        mcpServers: {},
        errors: [],
      });

      expect(report.openclaude.version).toBe("unknown");
    } finally {
      if (hadMacro) {
        (globalThis as Record<string, unknown>).MACRO = originalMacro;
      }
    }
  });

  test("parses report command output options", () => {
    expect(parseIssueReportArgs(["--json"])).toEqual({
      format: "json",
      outFile: null,
      includeDebug: false,
      redacted: true,
    });
    expect(
      parseIssueReportArgs(["--markdown", "--out", "report.md", "--redacted"]),
    ).toEqual({
      format: "markdown",
      outFile: "report.md",
      includeDebug: false,
      redacted: true,
    });
    expect(parseIssueReportArgs(["--out=nested/report.md"])).toEqual({
      format: "markdown",
      outFile: "nested/report.md",
      includeDebug: false,
      redacted: true,
    });
    expect(parseIssueReportArgs(["--include-debug"])).toEqual({
      format: "markdown",
      outFile: null,
      includeDebug: true,
      redacted: true,
    });
  });

  test("redacts include-debug error details", async () => {
    const home = homedir();
    const report = await buildIssueReport({
      env: baseEnv,
      cwd: `${home}/private/openclaude`,
      now: new Date("2026-06-15T10:30:00.000Z"),
      packageInfo: { version: "0.18.0" },
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: [],
        validationErrors: [],
      },
      mcpServers: {},
      errors: [
        {
          error: `ProviderError: failed with sk-openai-secret-token at ${home}/private/openclaude/src/file.ts`,
          timestamp: "2026-06-15T10:00:00.000Z",
        },
      ],
      includeDebug: true,
    });

    expect(report.errors.recent).toEqual([
      { category: "ProviderError", count: 1 },
    ]);
    expect(report.errors.debug).toEqual([
      "ProviderError: failed with [REDACTED_OPENAI_KEY] at ~/private/openclaude/src/file.ts",
    ]);
    expect(JSON.stringify(report)).not.toContain("sk-openai-secret-token");
    expect(JSON.stringify(report)).not.toContain(home);
  });

  test("reports public descriptor credential sources without arbitrary secret env names", async () => {
    const report = await buildIssueReport({
      env: {
        HOME: "/home/alice",
        PATH: "/usr/bin",
        CLAUDE_CODE_USE_GITHUB: "1",
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz",
        MY_PRIVATE_TOKEN: "private-token-value",
      },
      cwd: "/home/alice/private/openclaude",
      now: new Date("2026-06-15T10:30:00.000Z"),
      packageInfo: { version: "0.18.0" },
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: [],
        validationErrors: [],
      },
      mcpServers: {},
      errors: [],
    });
    const serialized = JSON.stringify(report);

    expect(report.provider.routeId).toBe("github");
    expect(report.provider.credential.present).toBe(true);
    expect(report.provider.credential.sources).toEqual(["GITHUB_TOKEN"]);
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("MY_PRIVATE_TOKEN");
    expect(serialized).not.toContain("private-token-value");
  });

  test("reports Codex alias runtime auth as Codex instead of OpenAI", async () => {
    const report = await buildIssueReport({
      env: {
        HOME: "/home/alice",
        PATH: "/usr/bin",
        CLAUDE_CODE_USE_OPENAI: "1",
        OPENAI_MODEL: "codexplan",
        CODEX_API_KEY: "codex-secret-token",
        CHATGPT_ACCOUNT_ID: "acct_codex",
      },
      cwd: "/home/alice/private/openclaude",
      now: new Date("2026-06-15T10:30:00.000Z"),
      packageInfo: { version: "0.18.0" },
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: [],
        validationErrors: [],
      },
      mcpServers: {},
      errors: [],
    });
    const serialized = JSON.stringify(report);

    expect(report.provider.routeId).toBe("codex");
    expect(report.provider.label).toBe("Codex");
    expect(report.provider.providerType).toBe("Codex Responses API");
    expect(report.provider.model).toBe("codexplan");
    expect(report.provider.baseUrl).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(report.provider.credential).toEqual({
      required: true,
      present: true,
      sources: ["CODEX_API_KEY", "CHATGPT_ACCOUNT_ID"],
    });
    expect(serialized).not.toContain("codex-secret-token");
    expect(serialized).not.toContain("acct_codex");
  });

  test("reports official Codex base URL as Codex instead of custom", async () => {
    const report = await buildIssueReport({
      env: {
        HOME: "/home/alice",
        PATH: "/usr/bin",
        CLAUDE_CODE_USE_OPENAI: "1",
        OPENAI_MODEL: "codexspark",
        OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex",
        CODEX_API_KEY: "codex-secret-token",
        CODEX_ACCOUNT_ID: "acct_codex",
      },
      cwd: "/home/alice/private/openclaude",
      now: new Date("2026-06-15T10:30:00.000Z"),
      packageInfo: { version: "0.18.0" },
      checks: {
        buildArtifactsPresent: true,
        ripgrep: { available: true, detail: "system rg" },
      },
      settings: {
        sourcesPresent: [],
        validationErrors: [],
      },
      mcpServers: {},
      errors: [],
    });

    expect(report.provider.routeId).toBe("codex");
    expect(report.provider.label).toBe("Codex");
    expect(report.provider.baseUrl).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(report.provider.credential).toEqual({
      required: true,
      present: true,
      sources: ["CODEX_API_KEY", "CODEX_ACCOUNT_ID"],
    });
  });

  test("writes report files and creates parent directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaude-report-"));
    try {
      const outFile = join(tempDir, "nested", "report.md");
      const outputPath = writeIssueReport(outFile, "redacted report");

      expect(outputPath).toBe(outFile);
      expect(existsSync(outFile)).toBe(true);
      expect(readFileSync(outFile, "utf8")).toBe("redacted report");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test.each(['GEMINI_VERTEX_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_PROJECT_ID'])(
  'native report uses its own model and %s instead of stale OpenAI fields',
  async projectKey => {
    const report = await buildIssueReport({
      env: {
        CLAUDE_CODE_USE_GEMINI_VERTEX: '1', [projectKey]: 'native-project',
        GEMINI_VERTEX_LOCATION: 'europe-west4', GEMINI_VERTEX_MODEL: 'gemini-2.5-pro',
        OPENAI_MODEL: 'gpt-5.5', OPENAI_BASE_URL: 'https://api.openai.com/v1',
      },
      cwd: process.cwd(), packageInfo: { version: 'test' },
      checks: { buildArtifactsPresent: true, ripgrep: { available: true, detail: 'fixture' } },
      settings: { sourcesPresent: [], validationErrors: [] }, mcpServers: {}, errors: [],
    })
    expect(report.provider.routeId).toBe('gemini-vertex')
    expect(report.provider.model).toBe('gemini-2.5-pro')
    expect(report.provider.baseUrl).toBe('https://europe-west4-aiplatform.googleapis.com/v1/projects/native-project/locations/europe-west4/publishers/google')
    expect(report.model.contextWindow).toBe(1_048_576)
    const markdown = formatIssueReportAsMarkdown(report)
    expect(markdown).toContain('gemini-2.5-pro')
    expect(markdown).toContain('native-project')
    expect(markdown).not.toContain('gpt-5.5')
    expect(markdown).not.toContain('api.openai.com')
  },
)

test.each([
  ['GEMINI_VERTEX_LOCATION', 'evil.example/x#'],
  ['GEMINI_VERTEX_PROJECT', 'project/other'],
] as const)('native report with unsafe %s does not publish a false endpoint', async (key, value) => {
  const report = await buildIssueReport({
    env: { CLAUDE_CODE_USE_GEMINI_VERTEX: '1', GEMINI_VERTEX_PROJECT: 'native-project',
      GEMINI_VERTEX_LOCATION: 'global', GEMINI_VERTEX_MODEL: 'gemini-2.5-flash',
      OPENAI_BASE_URL: 'https://api.openai.com/v1', [key]: value },
    cwd: process.cwd(), packageInfo: { version: 'test' },
    checks: { buildArtifactsPresent: true, ripgrep: { available: true, detail: 'fixture' } },
    settings: { sourcesPresent: [], validationErrors: [] }, mcpServers: {}, errors: [],
  })
  expect(report.provider.baseUrl).toBeUndefined()
  expect(formatIssueReportAsMarkdown(report)).not.toContain('Base URL: https://evil.example')
  expect(formatIssueReportAsMarkdown(report)).not.toContain('Base URL: https://api.openai.com')
})
