import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { execSync } from "node:child_process";
import { componentTagger } from "lovable-tagger";

function safeExec(command: string): string {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function readPackageVersion(): string {
  try {
    const pkgJson = fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8");
    const pkg = JSON.parse(pkgJson) as { version?: string };
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const gitBranch = safeExec("git rev-parse --abbrev-ref HEAD");
  const gitCommit = safeExec("git rev-parse --short HEAD");
  const gitRevisionCount = safeExec("git rev-list --count HEAD");

  const buildName = process.env.VITE_BUILD_NAME || process.env.GITHUB_REF_NAME || gitBranch || "";
  const buildNumber = process.env.VITE_BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || gitRevisionCount || "";
  const prNumber = process.env.VITE_PR_NUMBER || process.env.GITHUB_PR_NUMBER || "";
  const appVersion = process.env.VITE_APP_VERSION || readPackageVersion();
  const buildCommit =
    process.env.VITE_BUILD_COMMIT ||
    (process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : "") ||
    gitCommit ||
    "";

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    define: {
      __BUILD_NUMBER__: JSON.stringify(buildNumber),
      __BUILD_NAME__: JSON.stringify(buildName),
      __PR_NUMBER__: JSON.stringify(prNumber),
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_COMMIT__: JSON.stringify(buildCommit),
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom"],
    },
  };
});
