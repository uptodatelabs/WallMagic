//! 시나리오 자동 변경 규칙 엔진 — 트리거 평가 → 디바운스 → 시나리오 전환.
//!
//! 배경: `scenario.json` 은 "몇 분마다 자동 업데이트할지"만 표현한다. 사용자는
//! "아침에는 밝은 검색 시나리오, 밤에는 어두운 AI 시나리오"처럼 **시간대에 따라
//! 설정 자체를 바꾸고** 싶어 한다. 이 모듈은 그 요구를 [`ScenarioWorkspace`]
//! (프로필 목록 + 전환 규칙 + 디바운스 상태)로 표현한다.
//!
//! 설계 원칙
//! - 평가는 **순수 함수**다. 시각·요일은 호출자가 [`Clock`] 으로 넘긴다
//!   (시스템 시각에 직접 의존하면 테스트할 수 없다).
//! - 디바운스: 조건이 `debounce_secs` 동안 **연속으로** 참이어야 전환한다.
//!   한 틱만 참인 스파이크(자정 경계, 절전 복귀 직후)로 시나리오가 요동치지 않게 한다.
//! - 쿨다운: 전환 직후 `cooldown_secs` 동안은 같은 규칙이 다시 발동하지 않는다.
//! - 전환은 `scenario.json` 을 **덮어쓰는** 방식이다. 프로필이 진실의 원천이고
//!   기존 `scenario` IPC/UI 계약과 `scenario.json` 스키마는 그대로 유지된다.
//!
//! 스키마 (`app_data_dir()/scenario_profiles.json`):
//! ```json
//! {
//!   "profiles": [{ "id": "default", "name": "기본", "settings": { ... } }],
//!   "active_profile": "default",
//!   "rules": [{
//!     "id": "morning", "enabled": true,
//!     "trigger": { "kind": "time_window", "start_hour": 6, "end_hour": 12,
//!                  "weekdays": [1,2,3,4,5], "rotate_minutes": 240 },
//!     "target_profile": "bright", "debounce_secs": 30, "cooldown_secs": 600
//!   }],
//!   "last_switch_at": 1730000000,
//!   "last_auto_profile": "bright",
//!   "pending": [{ "rule_id": "morning", "since": 1729999980 }]
//! }
//! ```

use crate::scenario::{load_scenario, save_scenario, ScenarioSettings};
use crate::wallpaper::{app_data_dir, WallpaperError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// `end_hour` 기본값 — 24(자정)는 "그날의 끝"을 뜻한다.
fn default_end_hour() -> u32 {
    24
}

/// 디바운스 기본값(초). 자정 경계·절전 복귀 스파이크를 걸러낼 만큼 길고,
/// 사용자가 규칙을 켠 뒤 기다리기 답답하지 않을 만큼 짧다.
fn default_debounce_secs() -> u64 {
    30
}

/// 순환 주기 기본값(분) — 4시간.
fn default_rotate_minutes() -> u64 {
    240
}

/// 전환 대상이 되는 **시나리오 프로필** — `scenario.json` 전체를 이름과 함께 보관한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScenarioProfile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub settings: ScenarioSettings,
}

/// 트리거 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    /// 시간대 + 요일 조건 (자정을 넘는 구간 지원).
    #[default]
    TimeWindow,
    /// 앱 시작 직후 1회 (세션 시작 후 120초 이내).
    AppStart,
    /// 마지막 전환 후 `rotate_minutes` 경과 시 **다음 프로필로 순환**.
    Rotation,
}

/// 트리거 조건.
///
/// `weekdays` 는 0=일요일 … 6=토요일 (`SYSTEMTIME.wDayOfWeek` 와 같은 규약).
/// 빈 배열은 "요일 무관"을 뜻한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trigger {
    #[serde(default)]
    pub kind: TriggerKind,
    #[serde(default)]
    pub start_hour: u32,
    #[serde(default = "default_end_hour")]
    pub end_hour: u32,
    #[serde(default)]
    pub weekdays: Vec<u32>,
    #[serde(default = "default_rotate_minutes")]
    pub rotate_minutes: u64,
}

impl Default for Trigger {
    fn default() -> Self {
        Self {
            kind: TriggerKind::default(),
            start_hour: 0,
            end_hour: default_end_hour(),
            weekdays: Vec::new(),
            rotate_minutes: default_rotate_minutes(),
        }
    }
}

/// 자동 전환 규칙.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoSwitchRule {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trigger: Trigger,
    /// `Rotation` 이 아닌 트리거에서 전환 대상 프로필 id.
    #[serde(default)]
    pub target_profile: String,
    #[serde(default = "default_debounce_secs")]
    pub debounce_secs: u64,
    #[serde(default)]
    pub cooldown_secs: u64,
}

/// 디바운스 진행 상태 — "이 규칙이 언제부터 참이었는지".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRule {
    pub rule_id: String,
    pub since: u64,
}

/// 프로필 + 규칙 + 전환 이력의 영속 상태 (`scenario_profiles.json`).
///
/// `#[serde(default)]` 를 전 필드에 두어, 이후 필드가 추가돼도 구 파일이 그대로 로드된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ScenarioWorkspace {
    #[serde(default)]
    pub profiles: Vec<ScenarioProfile>,
    #[serde(default)]
    pub active_profile: Option<String>,
    #[serde(default)]
    pub rules: Vec<AutoSwitchRule>,
    #[serde(default)]
    pub last_switch_at: Option<u64>,
    #[serde(default)]
    pub last_auto_profile: Option<String>,
    #[serde(default)]
    pub pending: Vec<PendingRule>,
}

/// 평가에 쓰는 시계 — 시스템 시각을 직접 읽지 않고 **주입**한다(테스트 가능성).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    /// UNIX 초.
    pub now_secs: u64,
    /// 로컬 시각 0..=23.
    pub hour: u32,
    /// 로컬 요일 0=일 … 6=토.
    pub weekday: u32,
    /// 이 프로세스가 시작된 UNIX 초 (`AppStart` 트리거 판정용).
    pub session_start_secs: u64,
}

/// 전환 결정 1건.
///
/// `Serialize` 가 필요한 이유: IPC 커맨드(`evaluate_auto_switch`)가 이 값을 그대로
/// 반환한다. 없으면 Tauri 가 런타임에 직렬화 오류를 낸다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AutoSwitchOutcome {
    pub rule_id: String,
    pub profile_id: String,
}

/// 워크스페이스 파일 경로.
pub fn workspace_file_path() -> PathBuf {
    app_data_dir().join("scenario_profiles.json")
}

/// 워크스페이스 로드 — 파일이 없거나 비어 있으면 **빈 워크스페이스**를 돌려준다
/// (호출자가 [`ensure_seeded`] 로 현재 설정을 프로필로 승격시킨다).
pub fn load_workspace() -> Result<ScenarioWorkspace, WallpaperError> {
    let path = workspace_file_path();
    if !path.exists() {
        return Ok(ScenarioWorkspace::default());
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(ScenarioWorkspace::default());
    }
    serde_json::from_str(&text).map_err(|e| {
        WallpaperError::CandidateLoad(format!("scenario_profiles.json parse failed: {e}"))
    })
}

/// 워크스페이스 저장 (상위 디렉터리 자동 생성).
pub fn save_workspace(workspace: &ScenarioWorkspace) -> Result<(), WallpaperError> {
    let path = workspace_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(workspace).map_err(|e| {
        WallpaperError::CandidateLoad(format!("scenario_profiles.json serialize failed: {e}"))
    })?;
    std::fs::write(&path, text)?;
    Ok(())
}

/// `Rotation` 트리거의 대상 — 활성 프로필 **다음** 프로필(끝이면 처음으로 되돌아간다).
///
/// 프로필이 1개뿐이면 자기 자신이 나오고, 호출측의 "이미 활성" 검사에서 걸러진다
/// (같은 프로필로의 무의미한 전환을 만들지 않는다).
pub fn next_profile_after(workspace: &ScenarioWorkspace, active: Option<&str>) -> Option<String> {
    if workspace.profiles.is_empty() {
        return None;
    }
    match active.and_then(|a| workspace.profiles.iter().position(|p| p.id == a)) {
        Some(i) => Some(workspace.profiles[(i + 1) % workspace.profiles.len()].id.clone()),
        None => Some(workspace.profiles[0].id.clone()),
    }
}

/// 규칙이 **지금** 참인지 판정한다 (순수 함수 — IO·네트워크 없음).
///
/// `TimeWindow` 는 `start > end` 인 경우 자정을 넘는 구간으로 해석한다
/// (예: 22 → 6 은 "22시부터 다음날 6시까지").
pub fn trigger_matches(trigger: &Trigger, clock: &Clock, last_switch_at: Option<u64>) -> bool {
    match trigger.kind {
        TriggerKind::TimeWindow => {
            let start = trigger.start_hour.min(23);
            let end = trigger.end_hour.min(24);
            if start == end {
                // 폭 0 구간은 "항상"이 아니라 "없음"이다 — 무한 전환을 막는다.
                return false;
            }
            let in_window = if start < end {
                clock.hour >= start && clock.hour < end
            } else {
                clock.hour >= start || clock.hour < end
            };
            let day_ok =
                trigger.weekdays.is_empty() || trigger.weekdays.contains(&clock.weekday);
            in_window && day_ok
        }
        TriggerKind::AppStart => clock.now_secs.saturating_sub(clock.session_start_secs) <= 120,
        TriggerKind::Rotation => {
            let every = trigger.rotate_minutes.max(1).saturating_mul(60);
            last_switch_at
                .map_or(true, |last| clock.now_secs.saturating_sub(last) >= every)
        }
    }
}

/// 규칙 1건을 평가해 **전환할지** 결정하고 워크스페이스를 갱신한다 (순수 함수).
///
/// 반환값이 `Some` 이면 그 시점에 전환해야 한다 — 호출측이
/// [`switch_to_profile`] 로 `scenario.json` 을 실제로 덮어쓴다.
///
/// 부수 효과(워크스페이스 상태만):
/// - 디바운스 시작/진행(`pending`)
/// - 전환 확정 시 `active_profile`·`last_switch_at`·`last_auto_profile` 갱신, `pending` 초기화
/// - 조건이 깨진 규칙의 `pending` 제거
pub fn evaluate(
    workspace: &mut ScenarioWorkspace,
    clock: &Clock,
) -> Option<AutoSwitchOutcome> {
    // 대여 충돌을 피하려면 규칙 목록을 복제해야 한다(규칙 수는 수십 개 수준).
    let rules = workspace.rules.clone();
    let active = workspace.active_profile.clone();
    let mut ready: Option<(AutoSwitchRule, String)> = None;

    for rule in rules.iter() {
        if !rule.enabled {
            continue;
        }
        // 대상 결정: Rotation 은 "다음 프로필", 그 외는 명시된 target_profile.
        let target = if rule.trigger.kind == TriggerKind::Rotation {
            match next_profile_after(workspace, active.as_deref()) {
                Some(t) => t,
                None => continue,
            }
        } else {
            rule.target_profile.trim().to_string()
        };
        if target.is_empty() {
            continue;
        }
        if !workspace.profiles.iter().any(|p| p.id == target) {
            // 존재하지 않는 프로필을 가리키는 규칙은 조용히 무시한다(파일이 손으로 편집될 수 있다).
            continue;
        }
        if active.as_deref() == Some(target.as_str()) {
            continue;
        }
        if !trigger_matches(&rule.trigger, clock, workspace.last_switch_at) {
            continue;
        }
        if let Some(last) = workspace.last_switch_at {
            if clock.now_secs.saturating_sub(last) < rule.cooldown_secs {
                continue;
            }
        }
        match workspace
            .pending
            .iter()
            .find(|p| p.rule_id == rule.id)
            .map(|p| p.since)
        {
            None => {
                // 디바운스 0 = "즉시 전환" 계약이다. 첫 관측에서 pending 만 쌓고
                // 넘어가면 `Some(since)` 분기에 영원히 도달하지 못해 규칙이 절대
                // 발동하지 않는다(실측: debounce_secs=0 규칙이 첫 틱에서 전환되지 않아
                // `test_cooldown_blocks_repeat_switch`·`test_rotation_advances_to_next_profile` 실패).
                if rule.debounce_secs == 0 {
                    ready = Some((rule.clone(), target));
                    break;
                }
                // 첫 관측 — 이때부터 디바운스 계측을 시작한다.
                workspace.pending.push(PendingRule {
                    rule_id: rule.id.clone(),
                    since: clock.now_secs,
                });
            }
            Some(since) if clock.now_secs.saturating_sub(since) < rule.debounce_secs => {
                // 아직 유지 시간이 부족하다 — 다음 틱에 다시 본다.
            }
            Some(_) => {
                ready = Some((rule.clone(), target));
                break;
            }
        }
    }

    // 조건이 깨진 규칙의 pending 은 버린다 — 자정 경계·요일 변경·규칙 비활성화 후
    // 남은 since 값이 다음 조건 성립 시 "즉시 전환"으로 이어지는 것을 막는다.
    let rules_for_prune = workspace.rules.clone();
    let last_switch_at = workspace.last_switch_at;
    workspace.pending.retain(|p| {
        rules_for_prune.iter().any(|r| {
            r.id == p.rule_id && r.enabled && trigger_matches(&r.trigger, clock, last_switch_at)
        })
    });

    let (rule, target) = ready?;
    workspace.active_profile = Some(target.clone());
    workspace.last_switch_at = Some(clock.now_secs);
    workspace.last_auto_profile = Some(target.clone());
    workspace.pending.clear();
    Some(AutoSwitchOutcome {
        rule_id: rule.id,
        profile_id: target,
    })
}

/// 워크스페이스 상태만 갱신하고 **저장할 설정**을 돌려준다 (IO 없음).
///
/// `now_secs` 가 `Some` 이면 "방금 전환했다"로 기록한다(자동 전환). 수동 선택은
/// `None` 을 넘겨 쿨다운 타이머를 건드리지 않는다 — 수동 조작이 자동 규칙의
/// 쿨다운을 소모하면 사용자가 의도한 시각 전환이 밀린다.
pub fn set_active_profile(
    workspace: &mut ScenarioWorkspace,
    profile_id: &str,
    now_secs: Option<u64>,
) -> Option<ScenarioSettings> {
    let settings = workspace
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .map(|p| p.settings.clone())?;
    workspace.active_profile = Some(profile_id.to_string());
    workspace.pending.clear();
    if let Some(now) = now_secs {
        workspace.last_switch_at = Some(now);
        workspace.last_auto_profile = Some(profile_id.to_string());
    }
    Some(settings)
}

/// 전환 실행 — `scenario.json` 을 프로필 설정으로 덮어쓰고 워크스페이스를 저장한다.
///
/// `scenario.json` 저장이 먼저다. 저장에 실패하면 워크스페이스의 `active_profile` 도
/// 바뀌지 않아야 "표시는 바뀌었는데 실제 설정은 그대로"인 불일치가 생기지 않는다.
pub fn switch_to_profile(
    workspace: &mut ScenarioWorkspace,
    profile_id: &str,
    now_secs: Option<u64>,
) -> Result<ScenarioSettings, WallpaperError> {
    let mut probe = workspace.clone();
    let settings = set_active_profile(&mut probe, profile_id, now_secs).ok_or_else(|| {
        WallpaperError::CandidateLoad(format!("unknown scenario profile '{profile_id}'"))
    })?;
    save_scenario(&settings)?;
    save_workspace(&probe)?;
    *workspace = probe;
    Ok(settings)
}

/// 프로필이 비어 있으면 현재 `scenario.json` 을 `기본` 프로필로 승격한다.
///
/// 반환값 `true` = 시드가 발생했다(호출측이 저장하면 된다).
pub fn ensure_seeded(workspace: &mut ScenarioWorkspace) -> bool {
    if !workspace.profiles.is_empty() {
        return false;
    }
    let settings = load_scenario().unwrap_or_default();
    let id = workspace
        .active_profile
        .clone()
        .unwrap_or_else(|| "default".to_string());
    workspace.profiles.push(ScenarioProfile {
        id: id.clone(),
        name: "기본".to_string(),
        settings,
    });
    if workspace.active_profile.is_none() {
        workspace.active_profile = Some(id);
    }
    true
}

/// 로컬 시각의 (시, 요일) 을 구한다.
///
/// Windows 는 `GetLocalTime` 을 쓴다 — UTC 오프셋을 직접 계산하면 서머타임·표준시간대
/// 변경에서 어긋난다. 비-Windows 에서는 UNIX 초에서 **UTC** 기준으로 근사한다
/// (이 앱은 Windows 전용이므로 실사용 경로가 아니다).
#[cfg(windows)]
pub fn local_hour_weekday() -> (u32, u32) {
    // windows 0.62 실측 시그니처 (2회 컴파일 오류로 확인):
    //   (1) 위치: `Win32::System::Time` 이 아니라 `Win32::System::SystemInformation`
    //       (`System::Time` 으로 호출하면 E0425 "not found in `System::Time`").
    //   (2) 형태: 출력 포인터를 받는 `fn GetLocalTime(lpSystemTime: *mut SYSTEMTIME)` 이
    //       아니라 **인자 0개 + SYSTEMTIME 반환**이다
    //       (`&mut st as *mut _` 를 넘기면 E0061 "takes 0 arguments but 1 was supplied").
    //       C 헤더(kernel32)와 시그니처가 다르므로 포인터 관례를 그대로 옮기면 안 된다.
    // SAFETY: `GetLocalTime` 은 인자가 없고 유효한 SYSTEMTIME 값을 반환한다(실패 경로 없음).
    let st = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    // `wHour`·`wDayOfWeek` 는 `SYSTEMTIME` 에서 `u16` 이다 — `Clock` 은 `u32` 를 쓰므로
    // 여기서 변환한다(암묵 변환은 컴파일 오류 E0308).
    (st.wHour as u32, st.wDayOfWeek as u32)
}

/// 비-Windows 근사 (테스트·문서용).
#[cfg(not(windows))]
pub fn local_hour_weekday() -> (u32, u32) {
    let secs = crate::scenario::now_unix_secs();
    let hour = ((secs / 3600) % 24) as u32;
    // 1970-01-01 은 목요일(4)이다.
    let weekday = (((secs / 86_400) + 4) % 7) as u32;
    (hour, weekday)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_prompt(prompt: &str) -> ScenarioSettings {
        let mut s = ScenarioSettings::default();
        s.prompt = prompt.to_string();
        s
    }

    fn workspace_two_profiles() -> ScenarioWorkspace {
        ScenarioWorkspace {
            profiles: vec![
                ScenarioProfile {
                    id: "a".to_string(),
                    name: "A".to_string(),
                    settings: settings_with_prompt("morning"),
                },
                ScenarioProfile {
                    id: "b".to_string(),
                    name: "B".to_string(),
                    settings: settings_with_prompt("night"),
                },
            ],
            active_profile: Some("a".to_string()),
            ..Default::default()
        }
    }

    fn clock(now: u64, hour: u32, weekday: u32) -> Clock {
        Clock {
            now_secs: now,
            hour,
            weekday,
            session_start_secs: 0,
        }
    }

    fn rule(id: &str, trigger: Trigger, target: &str, debounce: u64) -> AutoSwitchRule {
        AutoSwitchRule {
            id: id.to_string(),
            enabled: true,
            trigger,
            target_profile: target.to_string(),
            debounce_secs: debounce,
            cooldown_secs: 0,
        }
    }

    /// 수용: 시간대 안/밖 판정
    #[test]
    fn test_time_window_inside_and_outside() {
        let t = Trigger {
            kind: TriggerKind::TimeWindow,
            start_hour: 6,
            end_hour: 12,
            weekdays: Vec::new(),
            rotate_minutes: 240,
        };
        assert!(trigger_matches(&t, &clock(0, 6, 1), None));
        assert!(trigger_matches(&t, &clock(0, 11, 1), None));
        assert!(!trigger_matches(&t, &clock(0, 12, 1), None));
        assert!(!trigger_matches(&t, &clock(0, 5, 1), None));
    }

    /// 수용: 자정을 넘는 구간 (22 → 6)
    #[test]
    fn test_time_window_wraps_past_midnight() {
        let t = Trigger {
            kind: TriggerKind::TimeWindow,
            start_hour: 22,
            end_hour: 6,
            weekdays: Vec::new(),
            rotate_minutes: 240,
        };
        assert!(trigger_matches(&t, &clock(0, 23, 1), None));
        assert!(trigger_matches(&t, &clock(0, 0, 1), None));
        assert!(trigger_matches(&t, &clock(0, 5, 1), None));
        assert!(!trigger_matches(&t, &clock(0, 6, 1), None));
        assert!(!trigger_matches(&t, &clock(0, 12, 1), None));
    }

    /// 수용: 요일 제한 — 빈 배열은 "요일 무관"
    #[test]
    fn test_time_window_weekdays_filter() {
        let mut t = Trigger {
            kind: TriggerKind::TimeWindow,
            start_hour: 0,
            end_hour: 24,
            weekdays: vec![1, 2, 3, 4, 5],
            rotate_minutes: 240,
        };
        assert!(trigger_matches(&t, &clock(0, 9, 1), None)); // 월
        assert!(!trigger_matches(&t, &clock(0, 9, 0), None)); // 일
        t.weekdays.clear();
        assert!(trigger_matches(&t, &clock(0, 9, 0), None));
    }

    /// 거부: 폭 0 구간(start == end)은 항상 참이 아니라 **없음**이다
    #[test]
    fn test_time_window_zero_width_never_matches() {
        let t = Trigger {
            kind: TriggerKind::TimeWindow,
            start_hour: 9,
            end_hour: 9,
            weekdays: Vec::new(),
            rotate_minutes: 240,
        };
        for hour in 0..24 {
            assert!(!trigger_matches(&t, &clock(0, hour, 3), None));
        }
    }

    /// 수용: AppStart 는 세션 시작 120초 이내에만 참
    #[test]
    fn test_app_start_window() {
        let t = Trigger {
            kind: TriggerKind::AppStart,
            ..Default::default()
        };
        let mut c = clock(1000, 9, 1);
        c.session_start_secs = 1000;
        assert!(trigger_matches(&t, &c, None));
        c = clock(1120, 9, 1);
        c.session_start_secs = 1000;
        assert!(trigger_matches(&t, &c, None));
        c = clock(1121, 9, 1);
        c.session_start_secs = 1000;
        assert!(!trigger_matches(&t, &c, None));
    }

    /// 수용: Rotation 은 마지막 전환 후 주기가 지나야 참 (전 이력이 없으면 즉시 참)
    #[test]
    fn test_rotation_interval() {
        let t = Trigger {
            kind: TriggerKind::Rotation,
            rotate_minutes: 10,
            ..Default::default()
        };
        let c = clock(10_000, 9, 1);
        assert!(trigger_matches(&t, &c, None));
        assert!(trigger_matches(&t, &c, Some(10_000 - 600)));
        assert!(!trigger_matches(&t, &c, Some(10_000 - 599)));
    }

    /// 수용: 디바운스 — 첫 관측은 전환하지 않고, 유지 시간이 지나야 전환한다
    #[test]
    fn test_debounce_requires_hold_then_switches() {
        let mut ws = workspace_two_profiles();
        ws.rules.push(rule(
            "r1",
            Trigger {
                kind: TriggerKind::TimeWindow,
                start_hour: 0,
                end_hour: 24,
                weekdays: Vec::new(),
                rotate_minutes: 240,
            },
            "b",
            60,
        ));

        // t=1000: 조건 참이지만 디바운스 계측 시작 -> 전환 없음
        let out = evaluate(&mut ws, &clock(1000, 9, 1));
        assert!(out.is_none(), "first observation must not switch");
        assert_eq!(ws.pending.len(), 1);
        assert_eq!(ws.pending[0].since, 1000);

        // t=1030: 30초 유지 — 아직 부족
        assert!(evaluate(&mut ws, &clock(1030, 9, 1)).is_none());

        // t=1060: 60초 유지 -> 전환
        let out = evaluate(&mut ws, &clock(1060, 9, 1)).expect("debounce elapsed");
        assert_eq!(out.rule_id, "r1");
        assert_eq!(out.profile_id, "b");
        assert_eq!(ws.active_profile.as_deref(), Some("b"));
        assert_eq!(ws.last_switch_at, Some(1060));
        assert!(ws.pending.is_empty(), "pending must be cleared after switch");
    }

    /// 거부: 이미 활성인 프로필로는 전환하지 않는다 (pending 도 만들지 않는다)
    #[test]
    fn test_no_switch_when_already_active() {
        let mut ws = workspace_two_profiles();
        ws.rules.push(rule(
            "r1",
            Trigger {
                kind: TriggerKind::TimeWindow,
                start_hour: 0,
                end_hour: 24,
                weekdays: Vec::new(),
                rotate_minutes: 240,
            },
            "a",
            0,
        ));
        assert!(evaluate(&mut ws, &clock(1000, 9, 1)).is_none());
        assert!(ws.pending.is_empty());
    }

    /// 거부: 쿨다운 중에는 같은 규칙이 다시 발동하지 않는다
    #[test]
    fn test_cooldown_blocks_repeat_switch() {
        let mut ws = workspace_two_profiles();
        let mut r = rule(
            "r1",
            Trigger {
                kind: TriggerKind::TimeWindow,
                start_hour: 0,
                end_hour: 24,
                weekdays: Vec::new(),
                rotate_minutes: 240,
            },
            "b",
            0,
        );
        r.cooldown_secs = 600;
        ws.rules.push(r);

        assert!(evaluate(&mut ws, &clock(1000, 9, 1)).is_some());
        // 활성 프로필을 되돌려 놓아도 쿨다운(600초) 안에서는 전환하지 않는다.
        ws.active_profile = Some("a".to_string());
        assert!(evaluate(&mut ws, &clock(1300, 9, 1)).is_none());
        assert!(evaluate(&mut ws, &clock(1600, 9, 1)).is_some());
    }

    /// 수용: Rotation 은 활성 프로필의 **다음** 프로필로 순환한다 (wrap 포함)
    #[test]
    fn test_rotation_advances_to_next_profile() {
        let mut ws = workspace_two_profiles();
        ws.rules.push(rule(
            "rot",
            Trigger {
                kind: TriggerKind::Rotation,
                rotate_minutes: 1,
                ..Default::default()
            },
            "",
            0,
        ));
        let out = evaluate(&mut ws, &clock(1000, 9, 1)).expect("rotation must switch");
        assert_eq!(out.profile_id, "b");
        assert_eq!(out.rule_id, "rot");

        // 프로필 2개: b -> a 로 되돌아온다
        let out = evaluate(&mut ws, &clock(2000, 9, 1)).expect("second rotation");
        assert_eq!(out.profile_id, "a");
    }

    /// 거부: 존재하지 않는 프로필을 가리키는 규칙은 무시된다
    #[test]
    fn test_missing_target_profile_is_ignored() {
        let mut ws = workspace_two_profiles();
        ws.rules.push(rule(
            "r1",
            Trigger {
                kind: TriggerKind::TimeWindow,
                start_hour: 0,
                end_hour: 24,
                weekdays: Vec::new(),
                rotate_minutes: 240,
            },
            "ghost",
            0,
        ));
        assert!(evaluate(&mut ws, &clock(1000, 9, 1)).is_none());
    }

    /// 수용: 조건이 깨지면 pending 이 제거된다 (스파이크 잔류 방지)
    #[test]
    fn test_pending_pruned_when_condition_breaks() {
        let mut ws = workspace_two_profiles();
        ws.rules.push(rule(
            "r1",
            Trigger {
                kind: TriggerKind::TimeWindow,
                start_hour: 9,
                end_hour: 10,
                weekdays: Vec::new(),
                rotate_minutes: 240,
            },
            "b",
            60,
        ));
        // 9시: 계측 시작
        assert!(evaluate(&mut ws, &clock(1000, 9, 1)).is_none());
        assert_eq!(ws.pending.len(), 1);
        // 10시: 구간 밖 -> pending 제거
        assert!(evaluate(&mut ws, &clock(2000, 10, 1)).is_none());
        assert!(
            ws.pending.is_empty(),
            "pending must be dropped when the window closes"
        );
    }

    /// 수용: 비활성 규칙은 평가에서 제외된다
    #[test]
    fn test_disabled_rule_is_skipped() {
        let mut ws = workspace_two_profiles();
        let mut r = rule(
            "r1",
            Trigger {
                kind: TriggerKind::TimeWindow,
                start_hour: 0,
                end_hour: 24,
                weekdays: Vec::new(),
                rotate_minutes: 240,
            },
            "b",
            0,
        );
        r.enabled = false;
        ws.rules.push(r);
        assert!(evaluate(&mut ws, &clock(1000, 9, 1)).is_none());
        assert!(ws.pending.is_empty());
    }

    /// 수용: 수동 선택은 쿨다운 타이머를 소모하지 않는다 (자동 전환 시각을 밀지 않는다)
    #[test]
    fn test_manual_switch_does_not_touch_last_switch_at() {
        let mut ws = workspace_two_profiles();
        ws.last_switch_at = Some(500);
        let settings = set_active_profile(&mut ws, "b", None).expect("profile b");
        assert_eq!(settings.prompt, "night");
        assert_eq!(ws.active_profile.as_deref(), Some("b"));
        assert_eq!(ws.last_switch_at, Some(500), "manual switch must not reset cooldown");
    }

    /// 거부: 없는 프로필로의 수동 선택은 None
    #[test]
    fn test_set_active_profile_unknown() {
        let mut ws = workspace_two_profiles();
        assert!(set_active_profile(&mut ws, "nope", None).is_none());
        assert_eq!(ws.active_profile.as_deref(), Some("a"));
    }

    /// 수용: next_profile_after 는 끝에서 처음으로 되돌아간다
    #[test]
    fn test_next_profile_after_wraps() {
        let ws = workspace_two_profiles();
        assert_eq!(next_profile_after(&ws, Some("a")).as_deref(), Some("b"));
        assert_eq!(next_profile_after(&ws, Some("b")).as_deref(), Some("a"));
        assert_eq!(next_profile_after(&ws, None).as_deref(), Some("a"));
        assert_eq!(next_profile_after(&ScenarioWorkspace::default(), None), None);
    }
}
