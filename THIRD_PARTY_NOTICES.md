# 제3자 라이선스 고지 (Third-Party Notices)

> 대상: WallMagic v1.0.0 (Windows) — Rust 워크스페이스 + 프론트엔드 번들
> 집계일: 2026-10-28
> 집계 방법: `cargo metadata --format-version 1 --locked` (Rust) · `package-lock.json` (npm)
> 관련 문서: [`LICENSE`](./LICENSE) · [`PRIVACY.md`](./PRIVACY.md) · [`SECURITY.md`](./SECURITY.md)

이 문서는 WallMagic이 **링크·번들하는 제3자 소프트웨어의 라이선스 요약**입니다.
각 패키지의 라이선스 **전문**은 해당 패키지 배포물에 포함된 `LICENSE*` 파일을 따릅니다.

---

## 1. 요약

| 생태계 | 집계 대상 | 라이선스 구성 |
|---|---|---|
| Rust (전이 의존성) | **483개** | MIT 계열 214+114+47 · Zlib 계열 · Unicode-3.0 18 · MPL-2.0 5 · CDLA-Permissive-2.0 2 |
| npm (전이 의존성) | **133개** | MIT 111 · Apache-2.0 OR MIT 13 · ISC 5 · Apache-2.0 2 · BSD-3-Clause 1 · CC-BY-4.0 1 |

**WallMagic 자체 코드**는 [`LICENSE`](./LICENSE) 의 **MIT** 입니다.

---

## 2. Rust 의존성

### 2.1 라이선스 그룹 (483개 집계)

| 라이선스 | 개수 |
|---|---|
| `MIT OR Apache-2.0` | 214 |
| `MIT` | 114 |
| `Apache-2.0 OR MIT` | 47 |
| `Zlib OR Apache-2.0 OR MIT` | 19 |
| `Unicode-3.0` | 18 |
| `MIT/Apache-2.0` | 12 |
| `Unlicense OR MIT` | 10 |
| `MPL-2.0` | 5 |
| `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 5 |
| `MIT OR Apache-2.0 OR Zlib` | 4 |
| `BSD-3-Clause` | 3 |
| `Apache-2.0/MIT` | 3 |
| `ISC` | 3 |
| `Zlib` | 2 |
| `MIT OR Zlib OR Apache-2.0` | 2 |
| `BSD-3-Clause OR Apache-2.0` | 2 |
| `BSD-3-Clause OR MIT OR Apache-2.0` | 2 |
| `MIT OR Apache-2.0 OR LGPL-2.1-or-later` | 2 |
| `Unlicense/MIT` | 2 |
| `Apache-2.0` | 2 |
| `CDLA-Permissive-2.0` | 2 |
| 그 외 복합 표기(0BSD · CC0-1.0 · MIT-0 · ISC 조합 등) | 16 |

### 2.2 직접 의존성

| 크레이트 | 버전 | 라이선스 |
|---|---|---|
| `tauri` | 2.12.5 | `Apache-2.0 OR MIT` |
| `base64` | 0.23.1 | `MIT OR Apache-2.0` |
| `serde` | 1.0.229 | `MIT OR Apache-2.0` |
| `serde_json` | 1.0.154 | `MIT OR Apache-2.0` |
| `thiserror` | 2.0.21 | `MIT OR Apache-2.0` |
| `tracing` | 0.1.44 | `MIT` |
| `ureq` | 2.12.1 | `MIT OR Apache-2.0` |
| `urlencoding` | 2.1.3 | `MIT` |
| `image` | 0.25.10 | `MIT OR Apache-2.0` |
| `windows` | 0.62.2 | `MIT OR Apache-2.0` |

### 2.3 주의가 필요한 라이선스

**MPL-2.0 (5개)** — 파일 단위 약한 카피레프트입니다. WallMagic은 이 크레이트들을 **수정하지 않고 의존**하며, MIT 배포와 양립합니다. 해당 소스는 공개 저장소에서 확인할 수 있습니다.

| 크레이트 | 버전 | 용도 |
|---|---|---|
| `cssparser` | 0.37.0 | CSS 파싱 (Tauri WebView 경로) |
| `cssparser-macros` | 0.7.1 | 위 크레이트의 매크로 |
| `selectors` | 0.38.0 | 셀렉터 엔진 (위와 동일 계열) |
| `dtoa-short` | 0.3.5 | 숫자 포매팅 (위와 동일 계열) |
| `option-ext` | 0.2.0 | 유틸리티 |

**Unicode-3.0 (18개)** — `icu_*` · `zerovec` · `yoke` · `tinystr` 등 국제화 데이터 크레이트입니다. Unicode License v3 는 MIT 와 유사한 관대한 라이선스입니다.

**CDLA-Permissive-2.0 (2개)** — `webpki-roots` (0.26.11 · 1.0.11). TLS 루트 인증서 번들로, 데이터 라이선스입니다.

**`MIT OR Apache-2.0 OR LGPL-2.1-or-later` (2개)** — `r-efi`. **MIT 또는 Apache-2.0 으로 선택**할 수 있으므로 LGPL 의무는 발생하지 않습니다.

---

## 3. npm 의존성

### 3.1 라이선스 그룹 (133개 집계)

| 라이선스 | 개수 |
|---|---|
| `MIT` | 111 |
| `Apache-2.0 OR MIT` | 13 |
| `ISC` | 5 |
| `Apache-2.0` | 2 |
| `BSD-3-Clause` | 1 |
| `CC-BY-4.0` | 1 |

### 3.2 주의가 필요한 라이선스

**CC-BY-4.0 (1개) — `caniuse-lite`** — 브라우저 호환성 데이터베이스입니다. **빌드 시점에만** 사용되며 런타임 번들에 포함되지 않습니다. CC-BY-4.0 은 저작자 표시를 요구하며, 이 문서가 그 역할을 합니다.

---

## 4. 재집계 방법 (검증 가능성)

```bash
# Rust — 라이선스 그룹 + 비허용/미확인 항목 추출
cargo metadata --format-version 1 --locked \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);const ws=new Set(m.workspace_members);const g={};for(const p of m.packages){if(ws.has(p.id))continue;const k=p.license||'UNKNOWN';g[k]=(g[k]||0)+1}const t=Object.values(g).reduce((a,b)=>a+b,0);console.log('RUST_TOTAL='+t);Object.entries(g).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(String(v).padStart(4)+'  '+k))})"

# npm — 라이선스 그룹
node -e "const l=require('./package-lock.json');const g={};for(const [k,v] of Object.entries(l.packages||{})){if(!k.startsWith('node_modules/'))continue;const q=v.license||'UNKNOWN';g[q]=(g[q]||0)+1}console.log('NPM_TOTAL='+Object.values(g).reduce((a,b)=>a+b,0));Object.entries(g).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(String(v).padStart(4)+'  '+k))"
```

> `cargo-about` / `cargo-license` 를 설치하면 크레이트별 라이선스 **전문**을 자동 생성할 수 있습니다. 이 문서는 외부 도구 없이 표준 `cargo metadata` 만으로 재집계 가능하도록 작성했습니다.

---

## 5. 이 문서의 한계

1. **라이선스 전문을 포함하지 않았습니다.** 각 패키지의 전문은 배포물 내 `LICENSE*` 파일을 따릅니다. 법적 배포 요건을 엄밀히 충족하려면 `cargo-about` 으로 전문 번들을 생성해야 합니다.
2. **Apache-2.0 의 `NOTICE` 파일 전파 여부를 확인하지 않았습니다.** Apache-2.0 크레이트 중 `NOTICE` 를 포함한 것이 있으면 그 내용을 함께 배포해야 합니다 — **미확인**.
3. **`cargo metadata --locked` 는 Windows 대상 의존성만 집계합니다.** 크로스 플랫폼 의존성(`objc2`, `ndk` 등)이 함께 집계되어 실제 Windows 번들보다 **많은 수치**일 수 있습니다. 즉 483개는 상한값입니다.
4. **런타임 번들 실제 구성과 대조하지 않았습니다.** `dist/assets/*.js` 에 tree-shaking 후 남은 패키지 목록을 추출해 npm 133개와 교차 확인하지 않았습니다.
5. **의존성 취약점(CVE) 스캔을 수행하지 않았습니다.** `cargo audit` · `npm audit` 미실행.
6. 집계일 기준이며, 의존성을 갱신하면 이 문서도 함께 갱신해야 합니다.
