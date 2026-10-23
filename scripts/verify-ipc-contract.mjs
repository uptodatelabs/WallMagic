#!/usr/bin/env node
// IPC 계약 검증: src-ui의 invoke("...") 이름 집합과 src-tauri의 #[tauri::command]
// 함수 이름 집합이 정확히 일치해야 한다. Tauri v2에서 IPC 명령 이름은 Rust 함수명
// 그대로 등록되므로, 이름이 어긋나면 UI 버튼이 런타임에서 "command not found"로 실패한다.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = readFileSync(resolve(root, "src-ui/App.tsx"), "utf8");
const rs = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");

const invocations = [...ui.matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
// Tauri v2 제한: lib.rs의 command 함수는 pub 불가(E0255) — pub 유무와 무관하게 매칭
const commands = [...rs.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?fn ([a-z_]+)/g)].map((m) => m[1]);

console.log("UI invokes   : " + invocations.join(", "));
console.log("Rust commands: " + commands.join(", "));

const missingInRust = invocations.filter((name) => !commands.includes(name));
const unusedInRust = commands.filter((name) => !invocations.includes(name));

if (missingInRust.length > 0 || unusedInRust.length > 0) {
  console.error(
    "MISMATCH missing_in_rust=[" +
      missingInRust.join(",") +
      "] unused_in_rust=[" +
      unusedInRust.join(",") +
      "]"
  );
  process.exit(1);
}
console.log("MATCH: IPC 명령 이름 계약 일치 (" + commands.length + " commands)");
