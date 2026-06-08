use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Clone, Serialize)]
struct Session {
    id: String,
    title: String,
    tokens: u32,
    context_used: u32,
    context_limit: u32,
    project_path: String,
    remote: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct RemoteConfig {
    backend_url: Option<String>,
    configured: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct SparkUserProfile {
    logged_in: bool,
    id: Option<String>,
    name: Option<String>,
    email: Option<String>,
    organization_id: Option<String>,
    organization_name: Option<String>,
    billing_type: Option<String>,
    account_created_at: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RemoteDeviceBinding {
    configured: bool,
    bound: bool,
    install_id: Option<String>,
    device_id: Option<String>,
    binding_id: Option<String>,
    client_name: Option<String>,
    package_name: String,
    app_version: String,
    status: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct RemoteClientConfig {
    binding_id: Option<String>,
    client_token: Option<String>,
    endpoint: Option<String>,
    stream_endpoint: Option<String>,
    client_name: Option<String>,
    status: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct AppPreferences {
    permission_mode: String,
    remote_control_at_startup: Option<bool>,
    auto_compact_enabled: bool,
    show_turn_duration: bool,
    terminal_progress_bar_enabled: bool,
    file_checkpointing_enabled: bool,
    respect_gitignore: bool,
    copy_full_response: bool,
    auto_connect_ide: bool,
    auto_install_ide_extension: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct ModelOption {
    id: String,
    name: String,
    description: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ModelConfig {
    selected: String,
    options: Vec<ModelOption>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RecentChange {
    id: String,
    title: String,
    path: String,
    summary: String,
    timestamp: String,
    status: String,
    can_revert: bool,
    before_content: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct SlashCommandEntry {
    name: String,
    description: String,
    aliases: Vec<String>,
    category: String,
    accepts_args: bool,
}

#[derive(Serialize)]
struct AppSnapshot {
    version: String,
    remote: RemoteConfig,
    spark_user: SparkUserProfile,
    remote_device: RemoteDeviceBinding,
    preferences: AppPreferences,
    model: ModelConfig,
    workspace: WorkspaceInfo,
    skills: Vec<SkillEntry>,
    mcp_servers: Vec<McpServerEntry>,
    projects: Vec<ProjectEntry>,
    recent_changes: Vec<RecentChange>,
    slash_commands: Vec<SlashCommandEntry>,
    sessions: Vec<Session>,
}

#[derive(Serialize)]
struct ChatMessage {
    id: String,
    role: String,
    content: String,
}

#[derive(Serialize)]
struct WorkspaceInfo {
    folder: String,
    path: String,
    mode: String,
    git_branch: Option<String>,
}

#[derive(Serialize)]
struct SkillEntry {
    id: String,
    name: String,
    source: String,
    path: String,
    description: Option<String>,
}

#[derive(Serialize)]
struct McpServerEntry {
    id: String,
    name: String,
    source: String,
    transport: String,
    command: Option<String>,
    url: Option<String>,
    enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct ProjectEntry {
    id: String,
    name: String,
    path: String,
    git_branch: Option<String>,
    trust_level: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct ProjectOverrides {
    added: Vec<ProjectEntry>,
    removed: Vec<String>,
}

static REMOTE_CONFIG: OnceLock<Mutex<RemoteConfig>> = OnceLock::new();
static MODEL_CONFIG: OnceLock<Mutex<ModelConfig>> = OnceLock::new();
static BACKEND_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static APP_SESSIONS: OnceLock<Mutex<Vec<Session>>> = OnceLock::new();
static FALLBACK_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

const FIXED_BACKEND_URL: &str = "https://chat.spark-ai.top";
const LOCAL_BACKEND_AUTH_TOKEN: &str = "sparkcode-app-local";
const SPARK_INSTALL_ID_ENV_KEY: &str = "SPARK_ANDROID_INSTALL_ID";
const SPARK_DEVICE_ID_ENV_KEY: &str = "SPARK_ANDROID_DEVICE_ID";
const SPARK_REFRESH_TOKEN_ENV_KEY: &str = "SPARK_ANDROID_REFRESH_TOKEN";
const SPARK_AUTH_TOKEN_ENV_KEY: &str = "ANTHROPIC_AUTH_TOKEN";
const SPARK_BASE_URL_ENV_KEY: &str = "ANTHROPIC_BASE_URL";
const BUNDLED_BACKEND_ROOT_ENV_KEY: &str = "SPARK_CODE_BUNDLED_BACKEND_ROOT";
const SPARK_PACKAGE_NAME: &str = "com.sparkatlas.app";
const SPARK_APP_VERSION: &str = "9.0.3";
const SPARK_CERT_SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OAUTH_CALLBACK_PATH: &str = "/spark/oauth/callback";
const SPARK_OAUTH_AUTHORIZE_PATH: &str = "/oauth/mobile/authorize";
const SPARK_AUTH_REFRESH_PATH: &str = "/api/v1/android/auth/refresh";
const SPARK_CODE_API_PATH: &str = "/api/v1/spark-code";

fn default_remote_config() -> RemoteConfig {
    RemoteConfig {
        backend_url: Some(FIXED_BACKEND_URL.to_string()),
        configured: true,
    }
}

fn default_spark_code_endpoint() -> String {
    format!("{FIXED_BACKEND_URL}{SPARK_CODE_API_PATH}")
}

fn is_loopback_endpoint(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let without_user = without_scheme
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(without_scheme);
    let authority = without_user.split('/').next().unwrap_or(without_user);
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next().unwrap_or(stripped)
    } else {
        authority.split(':').next().unwrap_or(authority)
    }
    .to_ascii_lowercase();

    host == "localhost" || host == "0.0.0.0" || host == "::1" || host.starts_with("127.")
}

fn resolve_remote_response_endpoint(value: Option<String>) -> Option<String> {
    match value {
        Some(endpoint) if is_loopback_endpoint(&endpoint) => Some(default_spark_code_endpoint()),
        endpoint => endpoint,
    }
}

fn resolve_remote_response_stream_endpoint(
    value: Option<String>,
    endpoint: &Option<String>,
) -> Option<String> {
    match value {
        Some(stream_endpoint) if is_loopback_endpoint(&stream_endpoint) => endpoint
            .as_ref()
            .map(|base| format!("{base}/client/sessions/{{session_id}}/events/stream")),
        stream_endpoint => stream_endpoint,
    }
}

fn remote_config() -> &'static Mutex<RemoteConfig> {
    REMOTE_CONFIG.get_or_init(|| Mutex::new(default_remote_config()))
}

fn default_model_options() -> Vec<ModelOption> {
    vec![
        ModelOption {
            id: "sonnet".to_string(),
            name: "Sonnet".to_string(),
            description: "Sonnet 4.6 · 适合日常编码任务".to_string(),
        },
        ModelOption {
            id: "opus".to_string(),
            name: "Opus".to_string(),
            description: "Opus 4.6 · 适合复杂任务".to_string(),
        },
        ModelOption {
            id: "haiku".to_string(),
            name: "Haiku".to_string(),
            description: "Haiku 4.5 · 适合快速回答".to_string(),
        },
        ModelOption {
            id: "sonnet[1m]".to_string(),
            name: "Sonnet（1M 上下文）".to_string(),
            description: "Sonnet 4.6 · 适合长会话".to_string(),
        },
        ModelOption {
            id: "opus[1m]".to_string(),
            name: "Opus（1M 上下文）".to_string(),
            description: "Opus 4.6 · 适合大型代码库长会话".to_string(),
        },
        ModelOption {
            id: "opusplan".to_string(),
            name: "Opus 计划模式".to_string(),
            description: "计划用 Opus，执行用 Sonnet".to_string(),
        },
        ModelOption {
            id: "best".to_string(),
            name: "Best".to_string(),
            description: "自动选择当前最佳模型".to_string(),
        },
    ]
}

fn default_model_config() -> ModelConfig {
    ModelConfig {
        selected: "opus[1m]".to_string(),
        options: default_model_options(),
    }
}

fn model_config_with_options(options: Vec<ModelOption>) -> ModelConfig {
    ModelConfig {
        selected: "opus[1m]".to_string(),
        options,
    }
}

fn ensure_selected_model_option(mut config: ModelConfig) -> ModelConfig {
    if !config
        .options
        .iter()
        .any(|option| option.id == config.selected)
    {
        config.options.push(ModelOption {
            id: config.selected.clone(),
            name: config.selected.clone(),
            description: "来自本机配置的模型名称".to_string(),
        });
    }
    config
}

fn backend_model_options() -> Vec<ModelOption> {
    start_spark_backend();
    let Ok(value) = post_local_backend_json("/model-options", &serde_json::json!({})) else {
        return default_model_options();
    };
    let Some(items) = value
        .get("options")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
    else {
        return default_model_options();
    };

    let mut options = Vec::new();
    for item in items {
        let Some(id) = value_string(item.get("id")).or_else(|| value_string(item.get("value")))
        else {
            continue;
        };
        let name = value_string(item.get("name"))
            .or_else(|| value_string(item.get("label")))
            .unwrap_or_else(|| id.clone());
        let description = value_string(item.get("description")).unwrap_or_default();
        if !options.iter().any(|option: &ModelOption| option.id == id) {
            options.push(ModelOption {
                id,
                name,
                description,
            });
        }
    }

    if options.is_empty() {
        default_model_options()
    } else {
        options
    }
}

fn model_config() -> &'static Mutex<ModelConfig> {
    MODEL_CONFIG.get_or_init(|| Mutex::new(default_model_config()))
}

fn app_sessions() -> &'static Mutex<Vec<Session>> {
    APP_SESSIONS.get_or_init(|| Mutex::new(Vec::new()))
}

fn config_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法访问应用配置目录".to_string())?;
    Ok(dir.join(file_name))
}

fn normalize_permission_mode(value: &str) -> String {
    match value.trim() {
        "auto-review" | "acceptEdits" | "auto" => "auto-review".to_string(),
        "full" | "bypassPermissions" | "dangerously-skip-permissions" => "full".to_string(),
        _ => "limited".to_string(),
    }
}

fn backend_permission_mode(value: &str) -> &'static str {
    match normalize_permission_mode(value).as_str() {
        "auto-review" => "acceptEdits",
        "full" => "bypassPermissions",
        _ => "default",
    }
}

fn load_project_overrides(app: &tauri::AppHandle) -> ProjectOverrides {
    let Ok(path) = config_path(app, "project-overrides.json") else {
        return ProjectOverrides::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return ProjectOverrides::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn persist_project_overrides(
    app: &tauri::AppHandle,
    overrides: &ProjectOverrides,
) -> Result<(), String> {
    let path = config_path(app, "project-overrides.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(overrides)
        .map_err(|error| format!("无法序列化目录配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存目录配置：{error}"))
}

fn spark_config_path() -> Result<PathBuf, String> {
    if let Some(config_dir) = env::var_os("SPARK_CONFIG_DIR") {
        return Ok(PathBuf::from(config_dir).join("spark.json"));
    }
    let home = env::var_os("HOME").ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".sparkc").join("spark.json"))
}

fn read_spark_config() -> Value {
    let Ok(path) = spark_config_path() else {
        return Value::Object(Map::new());
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Value::Object(Map::new());
    };
    serde_json::from_str(&content).unwrap_or_else(|_| Value::Object(Map::new()))
}

fn write_spark_config(config: &Value) -> Result<(), String> {
    let path = spark_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 Spark 配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化 Spark 配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存 Spark 配置：{error}"))
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn env_string(config: &Value, key: &str) -> Option<String> {
    value_string(config.get("env").and_then(|env| env.get(key))).or_else(|| {
        env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn root_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    if !config.is_object() {
        *config = Value::Object(Map::new());
    }
    config
        .as_object_mut()
        .ok_or_else(|| "Spark 配置格式无效".to_string())
}

fn env_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = root_object_mut(config)?;
    let env_value = root
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !env_value.is_object() {
        *env_value = Value::Object(Map::new());
    }
    env_value
        .as_object_mut()
        .ok_or_else(|| "Spark 环境配置格式无效".to_string())
}

fn get_or_create_android_device(config: &mut Value) -> Result<(String, String), String> {
    let env_root = env_object_mut(config)?;
    let install_id = value_string(env_root.get(SPARK_INSTALL_ID_ENV_KEY))
        .unwrap_or_else(|| compact_id("spark-code-"));
    let device_id = value_string(env_root.get(SPARK_DEVICE_ID_ENV_KEY))
        .unwrap_or_else(|| compact_id("spark-device-"));

    env_root.insert(
        SPARK_INSTALL_ID_ENV_KEY.to_string(),
        Value::String(install_id.clone()),
    );
    env_root.insert(
        SPARK_DEVICE_ID_ENV_KEY.to_string(),
        Value::String(device_id.clone()),
    );

    Ok((install_id, device_id))
}

fn config_bool(config: &Value, key: &str, default: bool) -> bool {
    config.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn read_json_file(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_skill_description(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(30) {
        let trimmed = line.trim();
        if let Some(description) = trimmed.strip_prefix("description:") {
            let value = description.trim().trim_matches('"').to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn collect_skills_from_dir(root: &Path, source: &str, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_path = path.join("SKILL.md");
        if !skill_path.is_file() {
            collect_skills_from_dir(&path, source, out);
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
            .to_string();
        out.push(SkillEntry {
            id: format!("{source}:{name}:{}", out.len()),
            name,
            source: source.to_string(),
            path: skill_path.display().to_string(),
            description: read_skill_description(&skill_path),
        });
    }
}

fn load_user_skills() -> Vec<SkillEntry> {
    let mut out = Vec::new();
    let Some(home) = home_dir() else {
        return out;
    };

    collect_skills_from_dir(&home.join(".codex").join("skills"), "codex", &mut out);
    collect_skills_from_dir(
        &home.join(".codex").join("vendor_imports").join("skills"),
        "codex",
        &mut out,
    );
    collect_skills_from_dir(&home.join(".claude").join("skills"), "claude", &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn mcp_entry_from_json(name: &str, source: &str, value: &Value) -> McpServerEntry {
    let command = value_string(value.get("command"));
    let url = value_string(value.get("url"));
    let transport = value_string(value.get("type")).unwrap_or_else(|| {
        if url.is_some() {
            "http".to_string()
        } else {
            "stdio".to_string()
        }
    });
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    McpServerEntry {
        id: format!("{source}:{name}"),
        name: name.to_string(),
        source: source.to_string(),
        transport,
        command,
        url,
        enabled,
    }
}

fn collect_json_mcp_servers(path: &Path, source: &str, out: &mut Vec<McpServerEntry>) {
    let Some(root) = read_json_file(path) else {
        return;
    };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return;
    };
    for (name, value) in servers {
        out.push(mcp_entry_from_json(name, source, value));
    }
}

fn parse_toml_string_value(line: &str, key: &str) -> Option<String> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    if rest.starts_with('"') {
        return rest
            .trim_matches('"')
            .split('"')
            .next()
            .map(str::to_string)
            .filter(|value| !value.is_empty());
    }
    Some(rest.trim().to_string()).filter(|value| !value.is_empty())
}

fn parse_toml_bool_value(line: &str, key: &str) -> Option<bool> {
    parse_toml_string_value(line, key).and_then(|value| match value.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    })
}

fn load_codex_config_text() -> Option<String> {
    let home = home_dir()?;
    fs::read_to_string(home.join(".codex").join("config.toml")).ok()
}

fn load_codex_mcp_servers() -> Vec<McpServerEntry> {
    let Some(content) = load_codex_config_text() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut current: Option<McpServerEntry> = None;
    let mut in_nested_mcp_section = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[mcp_servers.") && trimmed.ends_with(']') {
            let name = trimmed
                .trim_start_matches("[mcp_servers.")
                .trim_end_matches(']')
                .trim_matches('"')
                .to_string();
            if name.contains('.') {
                in_nested_mcp_section = true;
                continue;
            }
            if let Some(entry) = current.take() {
                out.push(entry);
            }
            in_nested_mcp_section = false;
            current = Some(McpServerEntry {
                id: format!("codex:{name}"),
                name,
                source: "codex".to_string(),
                transport: "stdio".to_string(),
                command: None,
                url: None,
                enabled: true,
            });
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(entry) = current.take() {
                out.push(entry);
            }
            in_nested_mcp_section = false;
            continue;
        }
        if in_nested_mcp_section {
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(value) = parse_toml_string_value(trimmed, "type") {
            entry.transport = value;
        } else if let Some(value) = parse_toml_string_value(trimmed, "command") {
            entry.command = Some(value);
        } else if let Some(value) = parse_toml_string_value(trimmed, "url") {
            entry.url = Some(value);
            if entry.transport == "stdio" {
                entry.transport = "http".to_string();
            }
        } else if let Some(value) = parse_toml_bool_value(trimmed, "enabled") {
            entry.enabled = value;
        }
    }
    if let Some(entry) = current {
        out.push(entry);
    }
    out
}

fn load_user_mcp_servers() -> Vec<McpServerEntry> {
    let mut out = load_codex_mcp_servers();
    if let Some(home) = home_dir() {
        collect_json_mcp_servers(
            &home.join(".claude").join("settings.json"),
            "claude",
            &mut out,
        );
        collect_json_mcp_servers(
            &home.join(".claude").join("config.json"),
            "claude",
            &mut out,
        );
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn load_codex_projects() -> Vec<ProjectEntry> {
    let Some(content) = load_codex_config_text() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_trust: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[projects.") && trimmed.ends_with(']') {
            if let Some(path) = current_path.take() {
                out.push(project_entry(path, current_trust.take()));
            }
            current_path = Some(
                trimmed
                    .trim_start_matches("[projects.")
                    .trim_end_matches(']')
                    .trim_matches('"')
                    .to_string(),
            );
            current_trust = None;
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(path) = current_path.take() {
                out.push(project_entry(path, current_trust.take()));
            }
            continue;
        }
        if current_path.is_some() {
            if let Some(value) = parse_toml_string_value(trimmed, "trust_level") {
                current_trust = Some(value);
            }
        }
    }
    if let Some(path) = current_path {
        out.push(project_entry(path, current_trust));
    }
    out
}

fn project_entry(path: String, trust_level: Option<String>) -> ProjectEntry {
    let path_buf = PathBuf::from(&path);
    let name = path_buf
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&path)
        .to_string();
    ProjectEntry {
        id: path.clone(),
        name,
        git_branch: read_git_branch(&path_buf),
        path,
        trust_level,
    }
}

fn load_spark_user_profile(config: &Value) -> SparkUserProfile {
    let account = config.get("oauthAccount").and_then(Value::as_object);
    let has_token = env_string(config, SPARK_AUTH_TOKEN_ENV_KEY).is_some()
        || env_string(config, SPARK_REFRESH_TOKEN_ENV_KEY).is_some();
    let logged_in = account.is_some() || has_token;

    SparkUserProfile {
        logged_in,
        id: account.and_then(|item| value_string(item.get("accountUuid"))),
        name: account
            .and_then(|item| value_string(item.get("displayName")))
            .or_else(|| logged_in.then(|| "已登录".to_string())),
        email: account.and_then(|item| value_string(item.get("emailAddress"))),
        organization_id: account.and_then(|item| value_string(item.get("organizationUuid"))),
        organization_name: account.and_then(|item| value_string(item.get("organizationName"))),
        billing_type: account.and_then(|item| value_string(item.get("billingType"))),
        account_created_at: account.and_then(|item| value_string(item.get("accountCreatedAt"))),
    }
}

fn is_auth_expired_message(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("401")
        || normalized.contains("invalid android token")
        || normalized.contains("登录已过期")
        || normalized.contains("令牌无效")
}

fn clear_spark_login_state() -> Result<Value, String> {
    let mut config = read_spark_config();
    if let Some(env_root) = config.get_mut("env").and_then(Value::as_object_mut) {
        env_root.remove(SPARK_AUTH_TOKEN_ENV_KEY);
        env_root.remove(SPARK_REFRESH_TOKEN_ENV_KEY);
        env_root.remove(SPARK_BASE_URL_ENV_KEY);
    }
    if let Some(root) = config.as_object_mut() {
        root.remove("oauthAccount");
    }
    write_spark_config(&config)?;
    Ok(config)
}

fn load_remote_device_binding(app: &tauri::AppHandle, config: &Value) -> RemoteDeviceBinding {
    let install_id = env_string(config, SPARK_INSTALL_ID_ENV_KEY);
    let device_id = env_string(config, SPARK_DEVICE_ID_ENV_KEY);
    let remote_client = load_remote_client_config(app);
    let has_client_token = remote_client
        .client_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    let configured = install_id.is_some() && device_id.is_some();
    let bound = has_client_token;
    let status = if bound {
        "已绑定".to_string()
    } else if configured {
        "待输入绑定码".to_string()
    } else {
        "未绑定".to_string()
    };

    RemoteDeviceBinding {
        configured,
        bound,
        install_id,
        device_id,
        binding_id: remote_client.binding_id,
        client_name: remote_client.client_name,
        package_name: SPARK_PACKAGE_NAME.to_string(),
        app_version: SPARK_APP_VERSION.to_string(),
        status,
    }
}

fn load_preferences(config: &Value) -> AppPreferences {
    AppPreferences {
        permission_mode: normalize_permission_mode(
            &value_string(config.get("permissionMode"))
                .or_else(|| value_string(config.get("backendPermissionMode")))
                .unwrap_or_else(|| "limited".to_string()),
        ),
        remote_control_at_startup: config
            .get("remoteControlAtStartup")
            .and_then(Value::as_bool),
        auto_compact_enabled: config_bool(config, "autoCompactEnabled", true),
        show_turn_duration: config_bool(config, "showTurnDuration", true),
        terminal_progress_bar_enabled: config_bool(config, "terminalProgressBarEnabled", true),
        file_checkpointing_enabled: config_bool(config, "fileCheckpointingEnabled", true),
        respect_gitignore: config_bool(config, "respectGitignore", true),
        copy_full_response: config_bool(config, "copyFullResponse", false),
        auto_connect_ide: config_bool(config, "autoConnectIde", false),
        auto_install_ide_extension: config_bool(config, "autoInstallIdeExtension", true),
    }
}

fn set_bool(root: &mut Map<String, Value>, key: &str, value: bool) {
    root.insert(key.to_string(), Value::Bool(value));
}

fn load_remote_config(_app: &tauri::AppHandle) -> RemoteConfig {
    default_remote_config()
}

fn persist_remote_config(app: &tauri::AppHandle, config: &RemoteConfig) -> Result<(), String> {
    let path = config_path(app, "remote.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化 Remote 配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存 Remote 配置：{error}"))
}

fn load_remote_client_config(app: &tauri::AppHandle) -> RemoteClientConfig {
    let Ok(path) = config_path(app, "remote-client.json") else {
        return RemoteClientConfig::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return RemoteClientConfig::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn persist_remote_client_config(
    app: &tauri::AppHandle,
    config: &RemoteClientConfig,
) -> Result<(), String> {
    let path = config_path(app, "remote-client.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化 Remote 绑定：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存 Remote 绑定：{error}"))
}

fn remove_remote_client_config(app: &tauri::AppHandle) -> Result<(), String> {
    let path = config_path(app, "remote-client.json")?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法清除 Remote 绑定：{error}"))?;
    }
    Ok(())
}

fn load_model_config(app: &tauri::AppHandle) -> ModelConfig {
    let options = backend_model_options();
    let default = model_config_with_options(options.clone());
    let Ok(path) = config_path(app, "model.json") else {
        return ensure_selected_model_option(load_user_model_config(default));
    };
    let Ok(content) = fs::read_to_string(path) else {
        return ensure_selected_model_option(load_user_model_config(default));
    };
    let mut config: ModelConfig = serde_json::from_str(&content).unwrap_or(default);
    if config.selected.trim().is_empty() {
        config.selected =
            load_user_model_config(model_config_with_options(options.clone())).selected;
    }
    config.options = options;
    ensure_selected_model_option(config)
}

fn load_user_model_config(mut default: ModelConfig) -> ModelConfig {
    let Some(home) = home_dir() else {
        return default;
    };

    if let Some(value) = read_json_file(&home.join(".claude").join("settings.json"))
        .and_then(|config| value_string(config.get("model")))
    {
        default.selected = normalize_model_alias(value);
        return default;
    }

    if let Some(content) = load_codex_config_text() {
        for line in content.lines() {
            if let Some(value) = parse_toml_string_value(line, "model") {
                default.selected = normalize_model_alias(value);
                return default;
            }
        }
    }

    default
}

fn normalize_model_alias(value: String) -> String {
    let options = default_model_options();
    if options.iter().any(|option| option.id == value) {
        return value;
    }
    let lower = value.to_lowercase();
    if lower.contains("opus") {
        "opus".to_string()
    } else if lower.contains("haiku") {
        "haiku".to_string()
    } else if lower.contains("sonnet") {
        "sonnet".to_string()
    } else {
        value
    }
}

fn persist_model_config(app: &tauri::AppHandle, config: &ModelConfig) -> Result<(), String> {
    let path = config_path(app, "model.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("无法序列化模型配置：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存模型配置：{error}"))
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                } else {
                    out.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|part| {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if url_decode(name) == key {
            Some(url_decode(value))
        } else {
            None
        }
    })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn write_oauth_html(stream: &mut TcpStream, title: &str, body: &str) {
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}}main{{width:min(420px,calc(100vw - 32px));background:#fff;border:1px solid #d9e0ea;border-radius:12px;padding:26px;box-shadow:0 18px 45px rgba(23,32,51,.10)}}h1{{margin:0 0 8px;font-size:22px}}p{{margin:0;color:#5d6a7c;line-height:1.5}}</style></head><body><main><h1>{}</h1><p>{}</p></main></body></html>",
        escape_html(title),
        escape_html(title),
        escape_html(body),
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.as_bytes().len(),
        html,
    );
    let _ = stream.write_all(response.as_bytes());
}

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = ProcessCommand::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = ProcessCommand::new("cmd");
        command.arg("/C").arg("start").arg("").arg(url);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = ProcessCommand::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开浏览器，请手动访问：{url}\n{error}"))
}

fn build_spark_oauth_url(
    callback_url: &str,
    state: &str,
    install_id: &str,
    device_id: &str,
) -> String {
    format!(
        "{FIXED_BACKEND_URL}{SPARK_OAUTH_AUTHORIZE_PATH}?redirect_uri={}&response_mode=query&install_id={}&device_id={}&package_name={}&cert_sha256={}&app_version={}&state={}",
        url_encode(callback_url),
        url_encode(install_id),
        url_encode(device_id),
        url_encode(SPARK_PACKAGE_NAME),
        url_encode(SPARK_CERT_SHA256),
        url_encode(SPARK_APP_VERSION),
        url_encode(state),
    )
}

fn wait_for_oauth_refresh_token(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法设置 OAuth 回调监听：{error}"))?;
    let deadline = Instant::now() + Duration::from_secs(10 * 60);

    loop {
        if Instant::now() >= deadline {
            return Err("等待 OAuth 回调超时，请重新登录".to_string());
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0_u8; 8192];
                let size = stream
                    .read(&mut buffer)
                    .map_err(|error| format!("读取 OAuth 回调失败：{error}"))?;
                let request = String::from_utf8_lossy(&buffer[..size]);
                let request_line = request.lines().next().unwrap_or_default();
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let (route, query) = path.split_once('?').unwrap_or((path, ""));

                if route == "/favicon.ico" {
                    let _ = stream.write_all(
                        b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }

                if route != OAUTH_CALLBACK_PATH {
                    write_oauth_html(
                        &mut stream,
                        "等待 Spark 授权",
                        "请在浏览器授权页面完成登录。",
                    );
                    continue;
                }

                if let Some(error) = query_value(query, "error") {
                    let message = query_value(query, "error_description").unwrap_or(error);
                    write_oauth_html(&mut stream, "登录失败", &message);
                    return Err(message);
                }

                let state =
                    query_value(query, "state").ok_or_else(|| "授权回调缺少 state".to_string())?;
                if state != expected_state {
                    write_oauth_html(&mut stream, "登录失败", "授权状态校验失败，请重新登录。");
                    return Err("授权状态校验失败，请重新登录".to_string());
                }

                let refresh_token = query_value(query, "refresh_token")
                    .ok_or_else(|| "授权回调里没有刷新令牌".to_string())?;
                write_oauth_html(
                    &mut stream,
                    "登录成功",
                    "可以关闭这个页面，回到 Spark Code。",
                );
                return Ok(refresh_token);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("OAuth 回调监听失败：{error}")),
        }
    }
}

fn curl_json(args: &[String]) -> Result<Value, String> {
    let output = ProcessCommand::new("curl")
        .args(args)
        .output()
        .map_err(|error| format!("无法调用 curl：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            "网络请求失败".to_string()
        } else {
            stderr
        });
    }

    let (body, status) = stdout
        .rsplit_once('\n')
        .ok_or_else(|| "后端响应格式无效".to_string())?;
    let status_code = status.trim().parse::<u16>().unwrap_or(0);
    if !(200..300).contains(&status_code) {
        let detail = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| {
                value_string(value.get("detail"))
                    .or_else(|| value_string(value.get("message")))
                    .or_else(|| value_string(value.get("error")))
            })
            .unwrap_or_else(|| body.trim().to_string());
        return Err(format!("后端返回 {status_code}：{detail}"));
    }
    serde_json::from_str(body).map_err(|error| format!("无法解析后端响应：{error}"))
}

fn refresh_android_token(
    refresh_token: &str,
    install_id: &str,
    device_id: &str,
) -> Result<(String, String), String> {
    let body = serde_json::json!({
        "refresh_token": refresh_token,
        "install_id": install_id,
        "device_id": device_id,
        "package_name": SPARK_PACKAGE_NAME,
        "cert_sha256": SPARK_CERT_SHA256,
        "app_version": SPARK_APP_VERSION,
    })
    .to_string();
    let url = format!("{FIXED_BACKEND_URL}{SPARK_AUTH_REFRESH_PATH}");
    let value = curl_json(&[
        "-sS".to_string(),
        "--max-time".to_string(),
        "20".to_string(),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        "-d".to_string(),
        body,
        url,
    ])?;

    let access_token = value_string(value.get("access_token"))
        .or_else(|| value_string(value.get("accessToken")))
        .ok_or_else(|| "后端没有返回访问令牌".to_string())?;
    let next_refresh_token = value_string(value.get("refresh_token"))
        .or_else(|| value_string(value.get("refreshToken")))
        .ok_or_else(|| "后端没有返回刷新令牌".to_string())?;
    Ok((access_token, next_refresh_token))
}

fn fetch_spark_profile(access_token: &str) -> Option<Value> {
    let url = format!("{FIXED_BACKEND_URL}/api/oauth/profile");
    curl_json(&[
        "-sS".to_string(),
        "--max-time".to_string(),
        "10".to_string(),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {access_token}"),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        url,
    ])
    .ok()
}

fn load_recent_changes(app: &tauri::AppHandle) -> Vec<RecentChange> {
    let Ok(path) = config_path(app, "changes.json") else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn persist_recent_changes(app: &tauri::AppHandle, changes: &[RecentChange]) -> Result<(), String> {
    let path = config_path(app, "changes.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let content = serde_json::to_string_pretty(changes)
        .map_err(|error| format!("无法序列化近期更改：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存近期更改：{error}"))
}

fn compact_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{prefix}{:x}", now % 0xffff_ffff)
}

fn fallback_session_uuid() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id() as u128;
    let count = FALLBACK_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    let hex = format!("{:032x}", now ^ (pid << 64) ^ count);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn app_log(message: impl AsRef<str>) {
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/sparkcode-app.log")
    {
        let _ = writeln!(file, "{}", message.as_ref());
    }
}

fn path_has_spark_source(path: &Path) -> bool {
    path.join("src")
        .join("server")
        .join("server-entry.ts")
        .is_file()
        && path.join("package.json").is_file()
}

fn find_spark_code_root() -> Option<PathBuf> {
    if let Some(path) = env::var_os("SPARK_CODE_ROOT").map(PathBuf::from) {
        if path_has_spark_source(&path) {
            return Some(path);
        }
    }

    if let Some(path) = env::var_os(BUNDLED_BACKEND_ROOT_ENV_KEY).map(PathBuf::from) {
        if path_has_spark_source(&path) {
            return Some(path);
        }
    }

    let mut starts = Vec::new();
    if let Ok(path) = env::current_dir() {
        starts.push(path);
    }
    if let Ok(path) = env::current_exe() {
        if let Some(parent) = path.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));

    for start in starts {
        for candidate in start.ancestors() {
            if path_has_spark_source(candidate) {
                return Some(
                    fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf()),
                );
            }
        }
    }

    None
}

fn bundled_bun_for_root(root: &Path) -> Option<PathBuf> {
    let candidate = root.join("runtime").join("bun");
    candidate.is_file().then_some(candidate)
}

fn is_app_resource_backend(path: &Path) -> bool {
    path.to_string_lossy()
        .contains(".app/Contents/Resources/spark-code-backend")
}

fn is_staged_backend_path(path: &Path) -> bool {
    path.to_string_lossy().contains("/.sparkc/backend/")
}

fn is_internal_backend_path(path: &Path) -> bool {
    is_app_resource_backend(path) || is_staged_backend_path(path)
}

fn copy_backend_resource(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| format!("无法清理后端缓存：{error}"))?;
    }
    fs::create_dir_all(target).map_err(|error| format!("无法创建后端缓存目录：{error}"))?;

    let source_contents = source.join(".");
    let status = ProcessCommand::new("/bin/cp")
        .arg("-R")
        .arg(&source_contents)
        .arg(target)
        .status()
        .map_err(|error| format!("无法复制内置后端：{error}"))?;
    if !status.success() {
        return Err(format!("复制内置后端失败：{status}"));
    }
    Ok(())
}

fn stage_bundled_backend_root(root: &Path) -> PathBuf {
    if cfg!(debug_assertions) || !is_app_resource_backend(root) {
        return root.to_path_buf();
    }

    let Some(home) = home_dir() else {
        return root.to_path_buf();
    };
    let target = home
        .join(".sparkc")
        .join("backend")
        .join(env!("CARGO_PKG_VERSION"));
    let stamp = target.join(".sparkcode-backend-source");
    let source_manifest =
        fs::read_to_string(root.join("backend-resource.json")).unwrap_or_else(|_| String::new());
    let source_text = format!("{}\n{}", root.display(), source_manifest);
    let target_ready = path_has_spark_source(&target)
        && bundled_bun_for_root(&target).is_some()
        && fs::read_to_string(&stamp)
            .map(|value| value == source_text)
            .unwrap_or(false);

    if target_ready {
        return target;
    }

    let tmp = target.with_extension(format!("tmp-{}", std::process::id()));
    app_log(format!(
        "backend:stage-copy source={} target={}",
        root.display(),
        target.display()
    ));
    match copy_backend_resource(root, &tmp) {
        Ok(()) => {
            if target.exists() {
                let _ = fs::remove_dir_all(&target);
            }
            if let Err(error) = fs::rename(&tmp, &target) {
                app_log(format!("backend:stage-rename-error {error}"));
                let _ = fs::remove_dir_all(&tmp);
                return root.to_path_buf();
            }
            let _ = fs::write(&stamp, source_text);
            target
        }
        Err(error) => {
            app_log(format!("backend:stage-copy-error {error}"));
            let _ = fs::remove_dir_all(&tmp);
            root.to_path_buf()
        }
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn open_log_stdio() -> Stdio {
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/sparkcode-app-backend.log")
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn backend_workspace() -> PathBuf {
    if let Some(workspace) = env::var_os("SPARK_CODE_WORKSPACE").map(PathBuf::from) {
        return fs::canonicalize(&workspace).unwrap_or(workspace);
    }

    if let Ok(current) = env::current_dir() {
        if !is_internal_backend_path(&current) && current != Path::new("/") {
            return fs::canonicalize(&current).unwrap_or(current);
        }
    }

    let workspace = home_dir().unwrap_or_else(|| PathBuf::from("."));

    fs::canonicalize(&workspace).unwrap_or(workspace)
}

fn backend_cache_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".sparkc").join("cache").join("sparkcode-app"))
}

fn configure_backend_environment(command: &mut ProcessCommand) {
    command
        .env_remove("XPC_SERVICE_NAME")
        .env_remove("XPC_FLAGS")
        .env_remove("__CFBundleIdentifier")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove(SPARK_AUTH_TOKEN_ENV_KEY)
        .env_remove(SPARK_REFRESH_TOKEN_ENV_KEY)
        .env_remove(SPARK_BASE_URL_ENV_KEY)
        .env("SPARK_CODE_BACKEND_LAUNCHED_BY", "sparkcode-app")
        .env("SPARK_CODE_REMOTE_BACKEND_URL", FIXED_BACKEND_URL);

    let spark_config = read_spark_config();
    if let Some(env_root) = spark_config.get("env").and_then(Value::as_object) {
        for key in [
            SPARK_AUTH_TOKEN_ENV_KEY,
            SPARK_REFRESH_TOKEN_ENV_KEY,
            SPARK_BASE_URL_ENV_KEY,
            SPARK_INSTALL_ID_ENV_KEY,
            SPARK_DEVICE_ID_ENV_KEY,
        ] {
            if let Some(value) = value_string(env_root.get(key)) {
                command.env(key, value);
            }
        }
    }

    if let Some(cache_dir) = backend_cache_dir() {
        let _ = fs::create_dir_all(&cache_dir);
        command
            .env("XDG_CACHE_HOME", &cache_dir)
            .env("BUN_INSTALL_CACHE_DIR", cache_dir.join("bun-install"))
            .env(
                "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
                cache_dir.join("bun-transpiler"),
            );
    }
}

fn describe_command(command: &ProcessCommand) -> String {
    let program = command.get_program().to_string_lossy();
    let args = command
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let cwd = command
        .get_current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "-".to_string());
    format!("program={program} cwd={cwd} args={args}")
}

fn build_backend_command() -> Result<(ProcessCommand, String), String> {
    let workspace = backend_workspace();

    if let Some(root) = find_spark_code_root() {
        let root = stage_bundled_backend_root(&root);
        let bun = bundled_bun_for_root(&root)
            .or_else(|| find_in_path("bun"))
            .unwrap_or_else(|| PathBuf::from("bun"));
        let mut command = ProcessCommand::new(bun);
        let entrypoint = root.join("src").join("server").join("server-entry.ts");
        command
            .current_dir(&root)
            .env("PWD", &root)
            .arg("--no-orphans")
            .arg("run")
            .arg(entrypoint)
            .arg("server")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("0")
            .arg("--auth-token")
            .arg(LOCAL_BACKEND_AUTH_TOKEN)
            .arg("--workspace")
            .arg(&workspace);
        return Ok((command, format!("source:{}", root.display())));
    }

    let sparkc = find_in_path("sparkc").unwrap_or_else(|| PathBuf::from("sparkc"));
    let mut command = ProcessCommand::new(sparkc);
    command
        .arg("server")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .arg("--auth-token")
        .arg(LOCAL_BACKEND_AUTH_TOKEN)
        .arg("--workspace")
        .arg(&workspace);
    Ok((command, "sparkc".to_string()))
}

fn backend_process() -> &'static Mutex<Option<Child>> {
    BACKEND_PROCESS.get_or_init(|| Mutex::new(None))
}

fn server_lock_path() -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".sparkc")
            .join(format!("sparkcode-app-{}.lock", std::process::id()))
    })
}

fn read_local_backend_url() -> Option<String> {
    let path = server_lock_path()?;
    let lock = read_json_file(&path)?;
    value_string(lock.get("httpUrl"))
}

fn wait_for_local_backend_url() -> Option<String> {
    for _ in 0..30 {
        if let Some(url) = read_local_backend_url() {
            if url.starts_with("http://") {
                return Some(url);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

fn parse_local_http_url(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "本地后端地址格式无效".to_string())?;
    let host_port = rest.split('/').next().unwrap_or(rest);
    let (host, port) = host_port
        .rsplit_once(':')
        .ok_or_else(|| "本地后端端口缺失".to_string())?;
    let port = port
        .parse::<u16>()
        .map_err(|_| "本地后端端口无效".to_string())?;
    Ok((host.to_string(), port))
}

fn post_local_backend_json(path: &str, body: &Value) -> Result<Value, String> {
    let url =
        wait_for_local_backend_url().ok_or_else(|| "本地 Spark Code 后端尚未就绪".to_string())?;
    let (host, port) = parse_local_http_url(&url)?;
    let body_text =
        serde_json::to_string(body).map_err(|error| format!("无法序列化请求：{error}"))?;
    let mut stream = TcpStream::connect((host.as_str(), port))
        .map_err(|error| format!("无法连接本地后端：{error}"))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {LOCAL_BACKEND_AUTH_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_text}",
        body_text.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("无法写入后端请求：{error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("无法读取后端响应：{error}"))?;
    let (_, payload) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "本地后端响应格式无效".to_string())?;
    let status_line = response.lines().next().unwrap_or_default().to_string();
    let value: Value =
        serde_json::from_str(payload).map_err(|error| format!("无法解析后端响应：{error}"))?;
    if !status_line.contains(" 200 ") {
        let message = value_string(value.get("error")).unwrap_or(status_line);
        return Err(message);
    }
    Ok(value)
}

fn canonical_project_path(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

fn create_backend_session_id(project_path: &str) -> Result<String, String> {
    start_spark_backend();
    let body = serde_json::json!({
        "cwd": project_path,
        "session_key": format!("sparkcode-app:{project_path}:{}", compact_id("")),
    });
    let value = post_local_backend_json("/sessions", &body)?;
    value_string(value.get("session_id")).ok_or_else(|| "本地后端没有返回会话 ID".to_string())
}

fn create_app_session(title: String, project_path: String, remote: bool) -> Session {
    let id = create_backend_session_id(&project_path).unwrap_or_else(|error| {
        app_log(format!("backend:create-session-error {error}"));
        fallback_session_uuid()
    });

    Session {
        id,
        title,
        tokens: 0,
        context_used: 0,
        context_limit: 1_000_000,
        project_path,
        remote,
    }
}

fn load_slash_commands(project_path: &str) -> Vec<SlashCommandEntry> {
    start_spark_backend();
    let body = serde_json::json!({
        "cwd": project_path,
    });
    match post_local_backend_json("/slash-commands", &body) {
        Ok(value) => {
            serde_json::from_value::<Vec<SlashCommandEntry>>(value).unwrap_or_else(|error| {
                app_log(format!("backend:slash-command-parse-error {error}"));
                Vec::new()
            })
        }
        Err(error) => {
            app_log(format!("backend:slash-command-load-error {error}"));
            Vec::new()
        }
    }
}

#[tauri::command]
fn get_slash_commands(project_path: String) -> Vec<SlashCommandEntry> {
    let project_path = if project_path.trim().is_empty() {
        canonical_project_path(backend_workspace())
    } else {
        canonical_project_path(project_path.trim())
    };
    load_slash_commands(&project_path)
}

#[tauri::command]
fn run_local_command(name: String, args: String) -> Result<String, String> {
    start_spark_backend();
    let body = serde_json::json!({
        "name": name.trim(),
        "args": args.trim(),
    });
    let value = post_local_backend_json("/local-command", &body)?;
    Ok(value_string(value.get("content")).unwrap_or_else(|| "已完成".to_string()))
}

fn ensure_default_sessions(remote: bool) -> Vec<Session> {
    let project_path = canonical_project_path(backend_workspace());
    let Ok(mut sessions) = app_sessions().lock() else {
        return vec![create_app_session(
            "当前会话".to_string(),
            project_path,
            remote,
        )];
    };

    if sessions.is_empty() {
        sessions.push(create_app_session(
            "当前会话".to_string(),
            project_path.clone(),
            remote,
        ));
    }

    if !sessions
        .iter()
        .any(|session| session.project_path == project_path)
    {
        sessions.push(create_app_session(
            "当前会话".to_string(),
            project_path,
            remote,
        ));
    }

    sessions.clone()
}

fn start_spark_backend() {
    let mut guard = match backend_process().lock() {
        Ok(guard) => guard,
        Err(_) => {
            app_log("backend:lock-unavailable");
            return;
        }
    };

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                app_log(format!("backend:already-running pid={}", child.id()));
                return;
            }
            Ok(Some(status)) => {
                app_log(format!("backend:previous-exited status={status}"));
                *guard = None;
            }
            Err(error) => {
                app_log(format!("backend:try-wait-error {error}"));
                *guard = None;
            }
        }
    }

    let (mut command, source) = match build_backend_command() {
        Ok(value) => value,
        Err(error) => {
            app_log(format!("backend:command-error {error}"));
            return;
        }
    };

    command
        .env("SPARK_CODE_BACKEND_LAUNCHED_BY", "sparkcode-app")
        .env("SPARK_CODE_REMOTE_BACKEND_URL", FIXED_BACKEND_URL)
        .stdin(Stdio::null())
        .stdout(open_log_stdio())
        .stderr(open_log_stdio());
    configure_backend_environment(&mut command);
    if let Some(lock_path) = server_lock_path() {
        let _ = fs::remove_file(&lock_path);
        app_log(format!("backend:lock-path {}", lock_path.display()));
        command.env("SPARK_CODE_SERVER_LOCK_PATH", lock_path);
    }
    app_log(format!("backend:command {}", describe_command(&command)));

    match command.spawn() {
        Ok(mut child) => {
            thread::sleep(Duration::from_millis(150));
            match child.try_wait() {
                Ok(Some(status)) => {
                    app_log(format!(
                        "backend:exited-after-spawn status={status} {source}"
                    ));
                }
                Ok(None) => {
                    app_log(format!("backend:spawned pid={} {source}", child.id()));
                    *guard = Some(child);
                }
                Err(error) => {
                    app_log(format!("backend:spawn-check-error {error} {source}"));
                    *guard = Some(child);
                }
            }
        }
        Err(error) => {
            app_log(format!("backend:spawn-error {error}"));
        }
    }
}

fn stop_spark_backend() {
    let Some(process) = BACKEND_PROCESS.get() else {
        return;
    };
    let Ok(mut guard) = process.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
        return;
    };

    app_log(format!("backend:stopping pid={}", child.id()));
    let _ = child.kill();
    let _ = child.wait();
    if let Some(lock_path) = server_lock_path() {
        let _ = fs::remove_file(lock_path);
    }
}

fn register_bundled_backend_resource(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(resource_dir) = app.path().resource_dir() else {
        return;
    };
    let backend_root = resource_dir.join("spark-code-backend");
    if path_has_spark_source(&backend_root) {
        env::set_var(BUNDLED_BACKEND_ROOT_ENV_KEY, backend_root);
    }
}

fn has_git_metadata(path: &Path) -> bool {
    path.ancestors()
        .take(8)
        .any(|candidate| candidate.join(".git").exists())
}

fn read_git_branch(path: &Path) -> Option<String> {
    if is_internal_backend_path(path) || !has_git_metadata(path) {
        return None;
    }

    let mut child = ProcessCommand::new("git")
        .arg("branch")
        .arg("--show-current")
        .current_dir(path)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= Duration::from_millis(300) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

fn workspace_info() -> WorkspaceInfo {
    let root = backend_workspace();
    let folder = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Spark Code")
        .to_string();

    WorkspaceInfo {
        folder,
        path: root.display().to_string(),
        mode: "编写模式".to_string(),
        git_branch: read_git_branch(&root),
    }
}

fn load_projects(app: &tauri::AppHandle) -> Vec<ProjectEntry> {
    let mut projects = load_codex_projects();
    let overrides = load_project_overrides(app);
    for project in overrides.added.iter().cloned() {
        if !projects.iter().any(|item| item.path == project.path) {
            projects.push(project);
        }
    }
    let current = project_entry(
        backend_workspace().display().to_string(),
        Some("current".to_string()),
    );
    if !projects.iter().any(|project| project.path == current.path) {
        projects.insert(0, current);
    }
    projects.retain(|project| {
        project.trust_level.as_deref() == Some("current")
            || !overrides.removed.iter().any(|path| path == &project.path)
    });
    projects
}

#[tauri::command]
fn get_app_snapshot(app: tauri::AppHandle) -> AppSnapshot {
    let spark_config = read_spark_config();
    let remote = load_remote_config(&app);
    if let Ok(mut config) = remote_config().lock() {
        *config = remote.clone();
    }
    let model = load_model_config(&app);
    if let Ok(mut config) = model_config().lock() {
        *config = model.clone();
    }
    let workspace = workspace_info();
    let projects = load_projects(&app);
    let sessions = ensure_default_sessions(remote.configured);

    AppSnapshot {
        version: env!("CARGO_PKG_VERSION").to_string(),
        remote: remote.clone(),
        spark_user: load_spark_user_profile(&spark_config),
        remote_device: load_remote_device_binding(&app, &spark_config),
        preferences: load_preferences(&spark_config),
        model,
        workspace,
        skills: load_user_skills(),
        mcp_servers: load_user_mcp_servers(),
        projects,
        recent_changes: load_recent_changes(&app),
        slash_commands: load_slash_commands(&sessions[0].project_path),
        sessions,
    }
}

#[tauri::command]
fn save_remote_config(app: tauri::AppHandle, _backend_url: String) -> Result<RemoteConfig, String> {
    let next = default_remote_config();

    let mut config = remote_config()
        .lock()
        .map_err(|_| "Remote 配置暂时不可用".to_string())?;
    persist_remote_config(&app, &next)?;
    *config = next.clone();
    Ok(next)
}

#[tauri::command]
fn save_preferences(preferences: AppPreferences) -> Result<AppPreferences, String> {
    let mut config = read_spark_config();
    if !config.is_object() {
        config = Value::Object(Map::new());
    }

    let root = config
        .as_object_mut()
        .ok_or_else(|| "Spark 配置格式无效".to_string())?;

    let permission_mode = normalize_permission_mode(&preferences.permission_mode);
    let backend_mode = backend_permission_mode(&permission_mode);
    root.insert(
        "permissionMode".to_string(),
        Value::String(permission_mode.clone()),
    );
    root.insert(
        "backendPermissionMode".to_string(),
        Value::String(backend_mode.to_string()),
    );
    let permissions_value = root
        .entry("permissions".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !permissions_value.is_object() {
        *permissions_value = Value::Object(Map::new());
    }
    if let Some(permissions) = permissions_value.as_object_mut() {
        permissions.insert(
            "defaultMode".to_string(),
            Value::String(backend_mode.to_string()),
        );
    }

    match preferences.remote_control_at_startup {
        Some(value) => {
            root.insert("remoteControlAtStartup".to_string(), Value::Bool(value));
        }
        None => {
            root.remove("remoteControlAtStartup");
        }
    }
    set_bool(root, "autoCompactEnabled", preferences.auto_compact_enabled);
    set_bool(root, "showTurnDuration", preferences.show_turn_duration);
    set_bool(
        root,
        "terminalProgressBarEnabled",
        preferences.terminal_progress_bar_enabled,
    );
    set_bool(
        root,
        "fileCheckpointingEnabled",
        preferences.file_checkpointing_enabled,
    );
    set_bool(root, "respectGitignore", preferences.respect_gitignore);
    set_bool(root, "copyFullResponse", preferences.copy_full_response);
    set_bool(root, "autoConnectIde", preferences.auto_connect_ide);
    set_bool(
        root,
        "autoInstallIdeExtension",
        preferences.auto_install_ide_extension,
    );

    write_spark_config(&config)?;
    Ok(AppPreferences {
        permission_mode,
        ..preferences
    })
}

#[tauri::command]
fn bind_remote_device(
    app: tauri::AppHandle,
    binding_code: String,
) -> Result<RemoteDeviceBinding, String> {
    let code = binding_code.trim();
    if code.is_empty() {
        return Err("请输入 Remote 绑定码".to_string());
    }

    let mut config = read_spark_config();
    let (install_id, device_id) = get_or_create_android_device(&mut config)?;
    write_spark_config(&config)?;

    let client_name = "Spark Code Desktop".to_string();
    let body = serde_json::json!({
        "code": code,
        "client_id": install_id,
        "client_name": client_name,
        "client_version": env!("CARGO_PKG_VERSION"),
        "data": {
            "platform": env::consts::OS,
            "editor": "sparkcode-app",
        },
        "meta": {
            "device_id": device_id,
            "app": "Spark Code",
        },
    })
    .to_string();
    let url = format!("{FIXED_BACKEND_URL}{SPARK_CODE_API_PATH}/client/bind");
    let value = curl_json(&[
        "-sS".to_string(),
        "--max-time".to_string(),
        "20".to_string(),
        "-w".to_string(),
        "\n%{http_code}".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        "-H".to_string(),
        "Content-Type: application/json".to_string(),
        "-d".to_string(),
        body,
        url,
    ])?;

    let client_token = value_string(value.get("client_token"))
        .ok_or_else(|| "后端没有返回 Remote client_token".to_string())?;
    let endpoint = resolve_remote_response_endpoint(value_string(value.get("endpoint")));
    let stream_endpoint = resolve_remote_response_stream_endpoint(
        value_string(value.get("stream_endpoint")),
        &endpoint,
    );
    let remote_client = RemoteClientConfig {
        binding_id: value_string(value.get("id")),
        client_token: Some(client_token),
        endpoint,
        stream_endpoint,
        client_name: value_string(value.get("client_name")).or(Some(client_name)),
        status: value_string(value.get("status")),
    };
    persist_remote_client_config(&app, &remote_client)?;

    let config = read_spark_config();
    Ok(load_remote_device_binding(&app, &config))
}

#[tauri::command]
fn unbind_remote_device(app: tauri::AppHandle) -> Result<RemoteDeviceBinding, String> {
    remove_remote_client_config(&app)?;
    let config = read_spark_config();
    Ok(load_remote_device_binding(&app, &config))
}

#[tauri::command]
fn logout_spark() -> Result<SparkUserProfile, String> {
    start_spark_backend();
    let _ = post_local_backend_json("/auth/clear", &serde_json::json!({}));

    let config = clear_spark_login_state()?;
    Ok(load_spark_user_profile(&config))
}

fn save_spark_login(
    access_token: String,
    refresh_token: String,
    profile: Option<Value>,
) -> Result<SparkUserProfile, String> {
    let mut config = read_spark_config();
    let _ = get_or_create_android_device(&mut config)?;

    {
        let env_root = env_object_mut(&mut config)?;
        env_root.insert(
            SPARK_BASE_URL_ENV_KEY.to_string(),
            Value::String(FIXED_BACKEND_URL.to_string()),
        );
        env_root.insert(
            SPARK_AUTH_TOKEN_ENV_KEY.to_string(),
            Value::String(access_token),
        );
        env_root.insert(
            SPARK_REFRESH_TOKEN_ENV_KEY.to_string(),
            Value::String(refresh_token),
        );
    }

    let mut oauth_account: Option<Map<String, Value>> = None;
    if let Some(profile) = profile {
        let account = profile.get("account").and_then(Value::as_object);
        let organization = profile.get("organization").and_then(Value::as_object);
        let account_uuid = account
            .and_then(|item| value_string(item.get("uuid")))
            .or_else(|| account.and_then(|item| value_string(item.get("account_uuid"))));
        let email = account
            .and_then(|item| value_string(item.get("email")))
            .or_else(|| account.and_then(|item| value_string(item.get("email_address"))));

        if let (Some(account_uuid), Some(email)) = (account_uuid, email) {
            let mut item = Map::new();
            item.insert("accountUuid".to_string(), Value::String(account_uuid));
            item.insert("emailAddress".to_string(), Value::String(email));
            if let Some(value) = account.and_then(|item| value_string(item.get("display_name"))) {
                item.insert("displayName".to_string(), Value::String(value));
            }
            if let Some(value) = account.and_then(|item| value_string(item.get("created_at"))) {
                item.insert("accountCreatedAt".to_string(), Value::String(value));
            }
            if let Some(value) = organization.and_then(|item| value_string(item.get("uuid"))) {
                item.insert("organizationUuid".to_string(), Value::String(value));
            }
            if let Some(value) = organization
                .and_then(|item| value_string(item.get("name")))
                .or_else(|| {
                    organization.and_then(|item| value_string(item.get("organization_name")))
                })
            {
                item.insert("organizationName".to_string(), Value::String(value));
            }
            if let Some(value) =
                organization.and_then(|item| value_string(item.get("billing_type")))
            {
                item.insert("billingType".to_string(), Value::String(value));
            }
            if let Some(value) =
                organization.and_then(|item| value_string(item.get("subscription_created_at")))
            {
                item.insert("subscriptionCreatedAt".to_string(), Value::String(value));
            }
            oauth_account = Some(item);
        }
    }

    {
        let root = root_object_mut(&mut config)?;
        root.insert("hasCompletedOnboarding".to_string(), Value::Bool(true));
        if let Some(account) = oauth_account {
            root.insert("oauthAccount".to_string(), Value::Object(account));
        }
    }

    write_spark_config(&config)?;
    Ok(load_spark_user_profile(&config))
}

#[tauri::command]
fn start_spark_login() -> Result<String, String> {
    let mut config = read_spark_config();
    let (install_id, device_id) = get_or_create_android_device(&mut config)?;
    write_spark_config(&config)?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法启动 OAuth 本地回调：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取 OAuth 回调端口：{error}"))?
        .port();
    let callback_url = format!("http://localhost:{port}{OAUTH_CALLBACK_PATH}");
    let state = compact_id("spark-oauth-");
    let auth_url = build_spark_oauth_url(&callback_url, &state, &install_id, &device_id);

    open_browser(&auth_url)?;
    let callback_refresh_token = wait_for_oauth_refresh_token(listener, &state)?;
    let (access_token, refresh_token) =
        refresh_android_token(&callback_refresh_token, &install_id, &device_id)?;
    let profile = fetch_spark_profile(&access_token);
    let user = save_spark_login(access_token, refresh_token, profile)?;

    Ok(user
        .name
        .or(user.email)
        .unwrap_or_else(|| "login-success".to_string()))
}

#[tauri::command]
fn revert_change(app: tauri::AppHandle, change_id: String) -> Result<Vec<RecentChange>, String> {
    let mut changes = load_recent_changes(&app);
    let change = changes
        .iter_mut()
        .find(|item| item.id == change_id)
        .ok_or_else(|| "没有找到这条更改记录".to_string())?;

    if !change.can_revert || change.status == "reverted" {
        return Err("这条更改不能 Revert".to_string());
    }

    let before_content = change
        .before_content
        .as_ref()
        .ok_or_else(|| "这条更改缺少可恢复内容".to_string())?;

    fs::write(&change.path, before_content).map_err(|error| format!("Revert 失败：{error}"))?;
    change.status = "reverted".to_string();
    change.can_revert = false;
    persist_recent_changes(&app, &changes)?;
    Ok(changes)
}

#[tauri::command]
fn save_model_config(app: tauri::AppHandle, model: String) -> Result<ModelConfig, String> {
    let selected = model.trim();
    if selected.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    let mut next = model_config_with_options(backend_model_options());
    next.selected = selected.to_string();
    next = ensure_selected_model_option(next);

    let mut config = model_config()
        .lock()
        .map_err(|_| "模型配置暂时不可用".to_string())?;
    persist_model_config(&app, &next)?;
    *config = next.clone();
    Ok(next)
}

#[tauri::command]
fn rename_session(session_id: String, title: String) -> Result<Vec<Session>, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    let mut sessions = app_sessions()
        .lock()
        .map_err(|_| "会话状态暂时不可用".to_string())?;
    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    session.title = trimmed.to_string();
    Ok(sessions.clone())
}

#[tauri::command]
fn archive_session(session_id: String) -> Result<Vec<Session>, String> {
    let mut sessions = app_sessions()
        .lock()
        .map_err(|_| "会话状态暂时不可用".to_string())?;
    let before = sessions.len();
    sessions.retain(|session| session.id != session_id);
    if sessions.len() == before {
        return Err("会话不存在".to_string());
    }
    Ok(sessions.clone())
}

#[tauri::command]
fn remove_project_path(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<Vec<ProjectEntry>, String> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let canonical = canonical_project_path(trimmed);
    let current = canonical_project_path(backend_workspace());
    if canonical == current {
        return Err("当前路径不能移除".to_string());
    }

    let mut overrides = load_project_overrides(&app);
    overrides.added.retain(|project| project.path != canonical);
    if !overrides.removed.iter().any(|path| path == &canonical) {
        overrides.removed.push(canonical.clone());
    }
    persist_project_overrides(&app, &overrides)?;

    if let Ok(mut sessions) = app_sessions().lock() {
        sessions.retain(|session| session.project_path != canonical);
    }

    Ok(load_projects(&app))
}

#[tauri::command]
fn add_project_path(
    app: tauri::AppHandle,
    path: String,
    base_path: String,
) -> Result<ProjectEntry, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请输入路径".to_string());
    }

    let input = PathBuf::from(trimmed);
    let path = if input.is_absolute() {
        input
    } else {
        let base = if base_path.trim().is_empty() {
            backend_workspace()
        } else {
            PathBuf::from(base_path.trim())
        };
        base.join(input)
    };
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("无法打开路径：{error}"))?;
    if !canonical.is_dir() {
        return Err("路径必须是文件夹".to_string());
    }

    let project = project_entry(canonical.display().to_string(), Some("added".to_string()));
    let mut overrides = load_project_overrides(&app);
    overrides.removed.retain(|path| path != &project.path);
    if !overrides.added.iter().any(|item| item.path == project.path) {
        overrides.added.push(project.clone());
    }
    persist_project_overrides(&app, &overrides)?;
    Ok(project)
}

#[tauri::command]
fn open_memory_file() -> Result<String, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let path = home.join(".sparkc").join("CLAUDE.md");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建记忆目录：{error}"))?;
    }
    if !path.exists() {
        fs::write(&path, "").map_err(|error| format!("无法创建记忆文件：{error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        ProcessCommand::new("open")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法打开记忆文件：{error}"))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let editor = env::var_os("VISUAL")
            .or_else(|| env::var_os("EDITOR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("vi"));
        ProcessCommand::new(editor)
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法打开记忆文件：{error}"))?;
    }

    Ok(path.display().to_string())
}

#[tauri::command]
fn export_session_text(
    file_name: String,
    project_path: String,
    content: String,
) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("请输入导出文件名".to_string());
    }

    let mut target = PathBuf::from(trimmed);
    if !target.is_absolute() {
        let base = if project_path.trim().is_empty() {
            backend_workspace()
        } else {
            PathBuf::from(project_path.trim())
        };
        target = base.join(target);
    }
    if target.extension().and_then(|extension| extension.to_str()) != Some("txt") {
        target.set_extension("txt");
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建导出目录：{error}"))?;
    }
    fs::write(&target, content).map_err(|error| format!("导出对话失败：{error}"))?;
    Ok(target.display().to_string())
}

#[tauri::command]
fn start_session(title: String, project_path: String) -> Session {
    let trimmed = title.trim();
    let remote = remote_config()
        .lock()
        .map(|config| config.configured)
        .unwrap_or(false);
    let project_path = if project_path.trim().is_empty() {
        canonical_project_path(backend_workspace())
    } else {
        canonical_project_path(project_path.trim())
    };
    let session = create_app_session(
        if trimmed.is_empty() {
            "新对话".to_string()
        } else {
            trimmed.to_string()
        },
        project_path,
        remote,
    );

    if let Ok(mut sessions) = app_sessions().lock() {
        sessions.insert(0, session.clone());
    }
    session
}

#[tauri::command]
fn send_prompt(
    prompt: String,
    session_id: String,
    project_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    resume: Option<bool>,
) -> Result<ChatMessage, String> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err("请输入要发送的内容".to_string());
    }

    start_spark_backend();
    let project_path = if project_path.trim().is_empty() {
        canonical_project_path(backend_workspace())
    } else {
        canonical_project_path(project_path.trim())
    };
    let mut body = serde_json::json!({
        "prompt": trimmed,
        "cwd": project_path,
    });
    if let Some(model) = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["model"] = serde_json::json!(model);
    }
    if let Some(permission_mode) = permission_mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["permission_mode"] = serde_json::json!(backend_permission_mode(permission_mode));
    }
    if let Some(resume) = resume {
        body["resume"] = serde_json::json!(resume);
    }
    let path = if session_id.trim().is_empty() {
        "/prompt".to_string()
    } else {
        format!("/sessions/{}/prompt", session_id.trim())
    };
    let value = match post_local_backend_json(&path, &body) {
        Ok(value) => value,
        Err(error) => {
            if is_auth_expired_message(&error) {
                let _ = clear_spark_login_state();
            }
            return Err(error);
        }
    };

    Ok(ChatMessage {
        id: value_string(value.get("id")).unwrap_or_else(|| compact_id("assistant-")),
        role: value_string(value.get("role")).unwrap_or_else(|| "assistant".to_string()),
        content: value_string(value.get("content")).unwrap_or_else(|| "已完成".to_string()),
    })
}

#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                let _ = app.set_dock_visibility(true);
                let _ = app.app_handle().show();
            }
            register_bundled_backend_resource(app.app_handle());
            start_spark_backend();
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .on_window_event(|_, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                stop_spark_backend();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            save_remote_config,
            save_preferences,
            bind_remote_device,
            unbind_remote_device,
            logout_spark,
            start_spark_login,
            revert_change,
            save_model_config,
            rename_session,
            archive_session,
            remove_project_path,
            add_project_path,
            open_memory_file,
            export_session_text,
            get_slash_commands,
            run_local_command,
            start_session,
            send_prompt,
            close_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Spark Code");
}
