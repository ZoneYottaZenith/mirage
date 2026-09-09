"""WanFaAI 独立生图站后端。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import logging

import requests
from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image
from werkzeug.utils import secure_filename

# 详细日志：生图链路（上游请求/响应/失败原因/退款）统一打到控制台
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("wanfa")

BASE_DIR = Path(__file__).resolve().parent
KEY_FILE = BASE_DIR / ".wanfa_key"
TASK_FILE = BASE_DIR / "image_tasks.json"
TASK_LOCK = threading.Lock()
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
# 生图单价（美元/张），后端为准，可后台动态调整（存 data/prices.json）
DEFAULT_PRICES = {"1K": 0.08, "2K": 0.15, "4K": 0.20}
# 金额以微美元（1$ = 1_000_000）存储，避免浮点误差
USD_UNIT = 1_000_000

# 数据目录与文件
DATA_DIR = BASE_DIR / "data"
CODES_FILE = DATA_DIR / "codes.json"
ACCOUNTS_FILE = DATA_DIR / "accounts.json"
TRANSACTIONS_FILE = DATA_DIR / "transactions.json"
GENERATED_DIR = DATA_DIR / "generated"
GENERATED_INDEX = GENERATED_DIR / "index.json"
# 监控图缩略图缓存：首次请求时生成 WebP 存这里，之后直接读缓存
GENERATED_THUMB_DIR = GENERATED_DIR / ".thumbs"
THUMB_MAX_EDGE = 512
# 监控缓存保留张数：默认 200，可在后台调整（存 data/cache_limit.json）
DEFAULT_CACHE_LIMIT = 200
CACHE_LIMIT_FILE = DATA_DIR / "cache_limit.json"
MAX_CACHE_LIMIT = 5000
PROVIDERS_FILE = DATA_DIR / "providers.json"
PRICES_FILE = DATA_DIR / "prices.json"
ANNOUNCEMENT_FILE = DATA_DIR / "announcement.json"
PURCHASE_FILE = DATA_DIR / "purchase.json"
MODEL_FILE = DATA_DIR / "model.json"
# 全局默认生图模型：用户端不传模型名，一律由服务端决定；中转站未单独指定时用它
DEFAULT_MODEL = "gpt-image-2.5"
# 默认中转站（万法）：兼容 OpenAI images 接口，用户可后台配置多个并切换
DEFAULT_GENERATION_ENDPOINT = "https://wanfaai.com/v1/images/generations"

# 用户身份：服务端签发令牌由指纹 + 密钥派生；指纹绑定浏览器，防令牌跨设备复制
FINGERPRINT_SALT = os.environ.get("WF_FINGERPRINT_SALT", "wanfa-image-lab-salt")
USER_COOKIE = "wf_user"          # 服务端用户 ID（HttpOnly）
FINGER_COOKIE = "wf_finger"      # 浏览器指纹（HttpOnly）
AUTH_COOKIE = "wf_auth"          # 签名令牌（HttpOnly）

_IO_LOCK = threading.RLock()  # 可重入锁：load/save_* 内部及 _update_account/redeem_code 等多处嵌套 with _IO_LOCK，普通 Lock 会死锁

ADMIN_HTML = BASE_DIR.parent / "frontend" / "admin.html"

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"))
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "change-this-secret-key")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024


@app.after_request
def add_no_store(response):
    """让浏览器每次都重新获取最新资源，彻底避免缓存旧 CSS/JS。"""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def get_api_key() -> str:
    """优先读取环境变量，其次读取本地受限配置文件。"""
    return os.environ.get("WANFA_IMAGE_API_KEY", "").strip() or (
        KEY_FILE.read_text(encoding="utf-8").strip() if KEY_FILE.exists() else ""
    )


def get_prices() -> dict[str, float]:
    """读取当前生图单价（美元/张），无文件时用默认值并落盘。"""
    if not PRICES_FILE.exists():
        save_prices(DEFAULT_PRICES)
        return dict(DEFAULT_PRICES)
    try:
        data = json.loads(PRICES_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return dict(DEFAULT_PRICES)
    return {tier: data.get(tier, DEFAULT_PRICES[tier]) for tier in DEFAULT_PRICES}


def save_prices(prices: dict[str, float]) -> None:
    with _IO_LOCK:
        PRICES_FILE.write_text(
            json.dumps(prices, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def get_global_model() -> str:
    """读取全局默认生图模型 ID，无配置时用 DEFAULT_MODEL。"""
    if not MODEL_FILE.exists():
        return DEFAULT_MODEL
    try:
        data = json.loads(MODEL_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return DEFAULT_MODEL
    return str(data.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL


def save_global_model(model: str) -> None:
    with _IO_LOCK:
        MODEL_FILE.write_text(
            json.dumps({"model": model}, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def resolve_model(provider: dict[str, Any] | None) -> str:
    """决定本次生成用哪个模型：中转站单独配置优先，否则用全局默认。"""
    if provider:
        own = str(provider.get("model") or "").strip()
        if own:
            return own
    return get_global_model()


def get_cache_limit() -> int:
    """监控缓存保留张数，可在后台调整。"""
    if not CACHE_LIMIT_FILE.exists():
        return DEFAULT_CACHE_LIMIT
    try:
        data = json.loads(CACHE_LIMIT_FILE.read_text(encoding="utf-8"))
        limit = int(data.get("limit", DEFAULT_CACHE_LIMIT))
    except (ValueError, OSError, TypeError):
        return DEFAULT_CACHE_LIMIT
    return max(1, min(MAX_CACHE_LIMIT, limit))


def save_cache_limit(limit: int) -> int:
    limit = max(1, min(MAX_CACHE_LIMIT, int(limit)))
    with _IO_LOCK:
        CACHE_LIMIT_FILE.write_text(
            json.dumps({"limit": limit}, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return limit


def purge_generated(keep: int = 0) -> dict[str, int]:
    """删除监控缓存文件并重建索引，keep=0 表示全清。
    返回 {removed, freed_bytes}——文件必须真删，否则磁盘不会释放。"""
    with _IO_LOCK:
        records = _read_json(GENERATED_INDEX, [])
        records.sort(key=lambda item: item.get("created", 0))
        victims = records[:max(0, len(records) - keep)] if keep else records
        freed = 0
        for item in victims:
            path = GENERATED_DIR / item.get("file", "")
            try:
                freed += path.stat().st_size
            except OSError:
                pass
            path.unlink(missing_ok=True)
            (GENERATED_THUMB_DIR / f"{item.get('id', '')}.webp").unlink(missing_ok=True)
        survivors = records[len(victims):]
        _write_json(GENERATED_INDEX, survivors)
        return {"removed": len(victims), "freed_bytes": freed}


def get_announcement_text() -> str:
    """读取底部公告文案，无则返回空串。"""
    if not ANNOUNCEMENT_FILE.exists():
        return ""
    try:
        data = json.loads(ANNOUNCEMENT_FILE.read_text(encoding="utf-8"))
        return str(data.get("text", ""))
    except (ValueError, OSError):
        return ""


def save_announcement_text(text: str) -> None:
    with _IO_LOCK:
        ANNOUNCEMENT_FILE.write_text(
            json.dumps({"text": text}, ensure_ascii=False), encoding="utf-8"
        )


def get_purchase_url() -> str:
    """读取购买额度链接，无则返回空串。"""
    if not PURCHASE_FILE.exists():
        return ""
    try:
        data = json.loads(PURCHASE_FILE.read_text(encoding="utf-8"))
        return str(data.get("url", ""))
    except (ValueError, OSError):
        return ""


def save_purchase_url(url: str) -> None:
    with _IO_LOCK:
        PURCHASE_FILE.write_text(
            json.dumps({"url": url}, ensure_ascii=False), encoding="utf-8"
        )


def _mask_key(key: str) -> str:
    return f"{key[:4]}••••{key[-4:]}" if key else ""


def load_providers() -> list[dict[str, Any]]:
    """读取中转站列表。首次使用时把旧的单 key + 硬编码 URL 自动迁移为一条默认中转站。"""
    if not PROVIDERS_FILE.exists():
        legacy_key = get_api_key()
        if legacy_key:
            default = [{
                "id": str(uuid.uuid4()),
                "name": "默认中转站",
                "url": DEFAULT_GENERATION_ENDPOINT,
                "key": legacy_key,
                "note": "自动迁移自旧的生图 Key（万法）",
                "active": True,
            }]
            save_providers(default)
            return default
        return []
    try:
        data = json.loads(PROVIDERS_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    return data.get("list", []) if isinstance(data, dict) else []


def save_providers(providers: list[dict[str, Any]]) -> None:
    with _IO_LOCK:
        PROVIDERS_FILE.write_text(
            json.dumps({"list": providers}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        try:
            os.chmod(PROVIDERS_FILE, 0o600)
        except OSError:
            pass


def get_active_provider() -> dict[str, Any] | None:
    """返回当前启用且已配置 Key 的中转站，没有则返回 None。"""
    for p in load_providers():
        if p.get("active") and p.get("key"):
            return p
    return None


def bump_active_provider_call() -> None:
    """当前启用的中转站生图成功一次，调用计数 +1。"""
    providers = load_providers()
    for p in providers:
        if p.get("active"):
            p["calls"] = int(p.get("calls", 0) or 0) + 1
            save_providers(providers)
            break


def edits_endpoint_for(url: str) -> str:
    """由图生图接口地址推导编辑接口地址（/images/generations -> /images/edits）。"""
    return url.replace("/images/generations", "/images/edits")


def normalize_generation_endpoint(url: str) -> str:
    """把中转站地址规范化为完整的生成接口地址。

    只需填中转站地址/域名，自动补全标准路径。兼容以下写法：
    - https://host                -> https://host/v1/images/generations
    - https://host/v1             -> https://host/v1/images/generations
    - https://host/v1/images      -> https://host/v1/images/generations
    - https://host/v1/images/generations -> 原样返回
    """
    base = (url or "").strip().rstrip("/")
    if base.endswith("/images/generations"):
        return base
    if base.endswith("/images"):
        return base + "/generations"
    if base.endswith("/v1"):
        return base + "/images/generations"
    return base + "/v1/images/generations"


def admin_password() -> str:
    return os.environ.get("ADMIN_PASSWORD", "admin123")


def _admin_token() -> str:
    """管理员令牌：由密码确定性派生，重启后不变。"""
    return hashlib.sha256(f"wanfa-admin:{admin_password()}".encode("utf-8")).hexdigest()


def require_admin() -> bool:
    """校验管理员令牌：优先 X-Admin-Token 请求头，兼容 ?token= 查询参数（图片无 header 可用）。"""
    supplied = request.headers.get("X-Admin-Token", "") or request.args.get("token", "")
    return bool(supplied) and supplied == _admin_token()


# ==================== 数据文件读写 ====================

def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def ensure_data() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    GENERATED_THUMB_DIR.mkdir(parents=True, exist_ok=True)
    if not CODES_FILE.exists():
        _write_json(CODES_FILE, [])
    if not ACCOUNTS_FILE.exists():
        _write_json(ACCOUNTS_FILE, {})
    if not TRANSACTIONS_FILE.exists():
        _write_json(TRANSACTIONS_FILE, [])
    if not GENERATED_INDEX.exists():
        _write_json(GENERATED_INDEX, [])


def load_codes() -> list[dict]:
    with _IO_LOCK:
        return _read_json(CODES_FILE, [])


def save_codes(codes: list[dict]) -> None:
    with _IO_LOCK:
        _write_json(CODES_FILE, codes)


def load_accounts() -> dict[str, dict]:
    with _IO_LOCK:
        return _read_json(ACCOUNTS_FILE, {})


def save_accounts(accounts: dict[str, dict]) -> None:
    with _IO_LOCK:
        _write_json(ACCOUNTS_FILE, accounts)


def load_transactions() -> list[dict]:
    with _IO_LOCK:
        return _read_json(TRANSACTIONS_FILE, [])


def save_transactions(transactions: list[dict]) -> None:
    with _IO_LOCK:
        _write_json(TRANSACTIONS_FILE, transactions)


# ==================== 激活码 ====================

# 激活码字符表：去掉易混淆的 0/O、1/I
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _gen_code(existing: list[dict]) -> str:
    def seg():
        return "".join(secrets.choice(CODE_CHARS) for _ in range(4))
    while True:
        prefix = "".join(secrets.choice(CODE_CHARS) for _ in range(2))
        code = f"{prefix}-{seg()}-{seg()}-{seg()}-{seg()}"
        if not any(item.get("code") == code for item in existing):
            return code


def _valid_code_format(code: str) -> bool:
    parts = code.split("-")
    if len(parts) != 5 or len(parts[0]) != 2:
        return False
    if any(len(p) != 4 for p in parts[1:]):
        return False
    return all(c in CODE_CHARS for p in parts for c in p)


# ==================== 用户身份（令牌 + 指纹绑定） ====================

def _fingerprint_token(fingerprint: str) -> str:
    return hmac.new(FINGERPRINT_SALT.encode(), fingerprint.encode(), hashlib.sha256).hexdigest()


def _issue_user_identity() -> tuple[str, str, str]:
    """给新用户签发身份：返回 (user_id, fingerprint, auth_token)。
    指纹由服务端生成并写入 HttpOnly cookie，令牌由指纹派生，实现 token 与浏览器绑定。"""
    fingerprint = secrets.token_urlsafe(24)
    user_id = uuid.uuid4().hex
    auth_token = _fingerprint_token(fingerprint)
    return user_id, fingerprint, auth_token


def _verify_auth(user_id: str, fingerprint: str, auth_token: str) -> bool:
    """校验令牌是否与指纹一致。"""
    if not (user_id and fingerprint and auth_token):
        return False
    return hmac.compare_digest(auth_token, _fingerprint_token(fingerprint))


def _new_account(user_id: str) -> dict:
    return {
        "user_id": user_id, "balance": 0, "recharged": 0, "spent": 0,
        "usage": 0, "created": time.time(), "last_used": None,
    }


def _read_current_user_id() -> str:
    """只读地取当前用户 ID，校验令牌与指纹匹配；不通过返回空串。
    与 _get_or_create_user 的区别：这里绝不创建账户——取图这类只读接口
    用它会凭空产生垃圾账户（每次无 cookie 的请求都写一次 accounts.json）。"""
    user_id = request.cookies.get(USER_COOKIE, "")
    fingerprint = request.cookies.get(FINGER_COOKIE, "")
    auth_token = request.cookies.get(AUTH_COOKIE, "")
    if user_id and _verify_auth(user_id, fingerprint, auth_token):
        return user_id
    return ""


def _get_or_create_user():
    """读取当前请求用户；首次访问自动创建账户并生成身份 Cookie。
    返回 (user_id, cookie_headers) —— cookie_headers 为需写入的 Cookie 列表，空表示已有有效身份。"""
    user_id = request.cookies.get(USER_COOKIE, "")
    fingerprint = request.cookies.get(FINGER_COOKIE, "")
    auth_token = request.cookies.get(AUTH_COOKIE, "")
    if user_id and fingerprint and _verify_auth(user_id, fingerprint, auth_token):
        accounts = load_accounts()
        accounts.setdefault(user_id, _new_account(user_id))
        save_accounts(accounts)
        return user_id, []
    # 无有效身份 → 创建新用户
    user_id, fingerprint, auth_token = _issue_user_identity()
    accounts = load_accounts()
    accounts.setdefault(user_id, _new_account(user_id))
    save_accounts(accounts)
    cookies = [
        {"name": USER_COOKIE, "value": user_id},
        {"name": FINGER_COOKIE, "value": fingerprint},
        {"name": AUTH_COOKIE, "value": auth_token},
    ]
    return user_id, cookies


def _attach_user_cookies(resp, cookies) -> None:
    for cookie in cookies:
        resp.set_cookie(cookie["name"], cookie["value"], httponly=True, samesite="Lax")


def validate_options(payload: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        return "请输入提示词。", None
    if len(prompt) > 4000:
        return "提示词不能超过 4000 个字符。", None

    tier = str(payload.get("tier", "1K")).upper()
    if tier not in get_prices():
        return "清晰度参数无效。", None

    count = max(1, min(50, int(payload.get("count", 1))))
    quality = str(payload.get("quality", "high")).lower()
    if quality not in {"auto", "high", "medium", "low"}:
        return "质量参数无效。", None

    # 比例为 "auto" 时不限定尺寸，交由提示词/模型自由发挥；否则映射到标准档位
    ratio = str(payload.get("ratio", "auto")).lower()
    sizes = {
        "1K": {"1:1": "1024x1024", "16:9": "1344x768", "9:16": "768x1344", "4:3": "1152x864", "3:4": "864x1152", "3:2": "1216x832", "2:3": "832x1216"},
        "2K": {"1:1": "2048x2048", "16:9": "2304x1296", "9:16": "1296x2304", "4:3": "2048x1536", "3:4": "1536x2048", "3:2": "2304x1536", "2:3": "1536x2304"},
        "4K": {"1:1": "4096x4096", "16:9": "3840x2160", "9:16": "2160x3840", "4:3": "4096x3072", "3:4": "3072x4096", "3:2": "4096x2736", "2:3": "2736x4096"},
    }
    auto_ratio = ratio == "auto"
    if not auto_ratio and ratio not in sizes[tier]:
        return "比例参数无效。", None

    # 模型名不由前端决定：这里不写 model，由 run_background_task 按中转站/全局配置注入
    payload_out = {
        "prompt": prompt,
        "quality": quality,
        "output_format": "png",
        "response_format": "b64_json",
        "n": count,
        "stream": False,
    }
    if not auto_ratio:
        payload_out["size"] = sizes[tier][ratio]
    return None, payload_out


def normalize_images(data: dict[str, Any]) -> list[dict[str, str]]:
    images: list[dict[str, str]] = []
    items = data.get("data") if isinstance(data, dict) else None
    for item in items or []:
        if not isinstance(item, dict):
            continue
        if item.get("b64_json"):
            images.append({"type": "base64", "value": item["b64_json"]})
        elif item.get("url"):
            images.append({"type": "url", "value": item["url"]})
    # SSE 事件风格：最终结果可能直接在顶层携带图片字段（如 image_generation.completed）
    if not images and isinstance(data, dict):
        for key in ("b64_json", "image_b64", "image_base64", "base64"):
            if data.get(key):
                images.append({"type": "base64", "value": data[key]})
                break
        if not images and data.get("url"):
            images.append({"type": "url", "value": data["url"]})
    return images


def read_tasks() -> dict[str, Any]:
    try:
        return json.loads(TASK_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_tasks(tasks: dict[str, Any]) -> None:
    temporary = TASK_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(tasks, ensure_ascii=False), encoding="utf-8")
    temporary.replace(TASK_FILE)


def update_task(task_id: str, **changes: Any) -> None:
    # 任务进入终态(成功/失败)时记录完成时间，供后续自动清理使用
    if changes.get("status") in ("done", "failed"):
        changes["done_at"] = time.time()
    with TASK_LOCK:
        tasks = read_tasks()
        if task_id in tasks:
            tasks[task_id].update(changes)
            write_tasks(tasks)


# 任务完成(成功/失败)后保留时长，到期由后台线程自动清理，防止 image_tasks.json 无限膨胀
TASK_TTL_SECONDS = 300


def cleanup_expired_tasks() -> None:
    """清理已完成(成功/失败)且超过 TTL 的任务记录。
    只删 image_tasks.json 里的临时任务记录，不影响管理员监控缓存与用户本地历史。"""
    now = time.time()
    expired: list[str] = []
    with TASK_LOCK:
        tasks = read_tasks()
        expired = [tid for tid, t in tasks.items()
                   if t.get("status") in ("done", "failed")
                   and now - float(t.get("done_at") or t.get("created") or 0) > TASK_TTL_SECONDS]
        for tid in expired:
            tasks.pop(tid, None)
        if expired:
            write_tasks(tasks)
    if expired:
        logger.info("[任务清理] 清理过期任务 %s 个", len(expired))


def _start_task_cleanup_worker() -> None:
    """后台守护线程：定期清理过期任务记录。"""
    def loop():
        while True:
            time.sleep(60)
            try:
                cleanup_expired_tasks()
            except Exception as exc:
                logger.warning("[任务清理] 清理失败: %s", exc)
    threading.Thread(target=loop, daemon=True).start()


# ==================== 余额 / 扣费 / 流水 / 兑换 ====================

def get_account(user_id: str) -> dict:
    accounts = load_accounts()
    return accounts.get(user_id, _new_account(user_id))


def _update_account(user_id: str, mutate) -> None:
    with _IO_LOCK:
        accounts = load_accounts()
        account = accounts.setdefault(user_id, _new_account(user_id))
        mutate(account)
        save_accounts(accounts)


def record_transaction(user_id: str, tier: str, count: int, cost_micro: int, status: str, task_id: str = "", error: str = "", provider: str = "") -> None:
    transactions = load_transactions()
    transactions.append({
        "user_id": user_id, "tier": tier, "count": count, "cost_micro": cost_micro,
        "status": status, "task_id": task_id, "error": error, "provider": provider, "created": time.time(),
    })
    # 只保留最近 500 条流水
    save_transactions(transactions[-500:])


def deduct_balance(user_id: str, cost_micro: int) -> bool:
    result = {"ok": False}
    _update_account(user_id, lambda a: result.update({"ok": a["balance"] >= cost_micro}) or a)
    if not result["ok"]:
        return False
    _update_account(user_id, lambda a: (
        a.update({"balance": a["balance"] - cost_micro, "spent": a["spent"] + cost_micro,
                  "usage": a["usage"] + 1, "last_used": time.time()})
    ))
    return True


def refund_balance(user_id: str, cost_micro: int) -> None:
    _update_account(user_id, lambda a: a.update({"balance": a["balance"] + cost_micro, "spent": a["spent"] - cost_micro}))


def redeem_code(code: str, user_id: str) -> tuple[bool, str]:
    code = (code or "").strip().upper()
    if not _valid_code_format(code):
        return False, "激活码格式无效。"
    with _IO_LOCK:
        codes = load_codes()
        target = next((c for c in codes if c.get("code") == code), None)
        if not target:
            return False, "激活码不存在。"
        if not target.get("enabled", True):
            return False, "激活码已被禁用。"
        if target.get("redeemed_at"):
            return False, "激活码已被兑换。"
        amount = int(target.get("amount_micro", 0))
        target["redeemed_at"] = time.time()
        target["redeemed_by"] = user_id
        save_codes(codes)
    with _IO_LOCK:
        accounts = load_accounts()
        account = accounts.setdefault(user_id, _new_account(user_id))
        account["balance"] = account.get("balance", 0) + amount
        account["recharged"] = account.get("recharged", 0) + amount
        save_accounts(accounts)
    record_transaction(user_id, "Redeem", 1, amount, "recharge")
    return True, f"兑换成功，已到账 ${amount / USD_UNIT:.2f}"


def save_generated_image(image: dict[str, str], task_id: str, user_id: str, prompt: str = "", model: str = "") -> str:
    """管理员监控缓存：把生成结果原图落盘，索引记录，超出保留上限时删最旧。
    返回图片 ID。仅用于管理员审计，与用户浏览器本地缓存完全独立。"""
    image_id = uuid.uuid4().hex
    file_path = GENERATED_DIR / f"{image_id}.png"
    if image.get("type") == "base64":
        file_path.write_bytes(base64.b64decode(image.get("value", "")))
    else:
        return ""
    limit = get_cache_limit()
    with _IO_LOCK:
        records = _read_json(GENERATED_INDEX, [])
        records.append({"id": image_id, "task_id": task_id, "user_id": user_id,
                        "created": time.time(), "file": file_path.name,
                        "prompt": prompt, "model": model})
        records.sort(key=lambda item: item.get("created", 0))
        for old in records[:-limit]:
            (GENERATED_DIR / old.get("file", "")).unlink(missing_ok=True)
            (GENERATED_THUMB_DIR / f"{old.get('id', '')}.webp").unlink(missing_ok=True)
        _write_json(GENERATED_INDEX, records[-limit:])
    return image_id


def _generated_record(image_id: str) -> dict[str, Any] | None:
    """按图片 ID 在监控缓存索引里查记录。"""
    if not image_id:
        return None
    records = _read_json(GENERATED_INDEX, [])
    return next((x for x in records if x.get("id") == image_id), None)


def _generated_path(image_id: str) -> Path | None:
    """监控缓存原图路径，文件已被清理时返回 None。"""
    item = _generated_record(image_id)
    if not item:
        return None
    path = GENERATED_DIR / item.get("file", "")
    return path if path.exists() else None


def _generated_thumb_file(image_id: str) -> Path | None:
    """监控缓存缩略图（WebP）：没有就现生成一次并落盘，之后直接读缓存。"""
    src = _generated_path(image_id)
    if not src:
        return None
    thumb = GENERATED_THUMB_DIR / f"{image_id}.webp"
    if thumb.exists():
        return thumb
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.LANCZOS)
            im.save(thumb, "WEBP", quality=82, method=4)
    except (OSError, ValueError) as exc:
        logger.warning("[缩略图] 生成失败 %s: %s", image_id[:8], exc)
        return None
    return thumb


def _resolve_generate_result(response) -> dict:
    """解析生成接口响应：SSE 流式逐行读全部事件，自动挑出含图片数据的那个；否则按普通 JSON。"""
    ctype = response.headers.get("content-type", "")
    if "text/event-stream" in ctype.lower():
        payloads: list[str] = []
        try:
            for raw in response.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                line = raw.strip()
                if line.startswith("data:"):
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    if payload:
                        payloads.append(payload)
        finally:
            response.close()
        if not payloads:
            raise RuntimeError("流式响应中没有有效数据。")
        events: list[dict] = []
        for p in payloads:
            try:
                events.append(json.loads(p))
            except json.JSONDecodeError:
                continue
        if not events:
            raise RuntimeError("无法解析流式响应中的 JSON 事件。")

        def has_image(ev) -> bool:
            if not isinstance(ev, dict):
                return False
            d = ev.get("data")
            if isinstance(d, list) and d:
                return True
            return bool(ev.get("b64_json") or ev.get("image_b64") or ev.get("image_base64") or ev.get("base64") or ev.get("url"))

        picked = next((ev for ev in reversed(events) if has_image(ev)), None)
        if picked is None:
            raise RuntimeError(
                f"流式响应 {len(events)} 个事件中未发现图片数据，末事件片段: {json.dumps(events[-1], ensure_ascii=False)[:300]}")
        logger.info("[生图] SSE 共 %s 个事件，采用含图片数据的末事件 type=%s", len(events), picked.get("type", "-"))
        return picked
    try:
        return json.loads(response.text)
    finally:
        response.close()


def run_background_task(task_id: str, payload: dict[str, Any], files_data: list[tuple[str, bytes, str]], user_id: str, cost_micro: int, tier: str, count: int) -> None:
    update_task(task_id, status="running")
    started = time.time()
    provider_label = ""
    try:
        provider = get_active_provider()
        provider_label = (provider.get("name") or provider.get("id") or "") if provider else ""
        error, image_payload = validate_options(payload)
        if error or not provider:
            raise RuntimeError(error or "服务端尚未配置可用的生图中转站，请联系管理员。")
        # 模型由服务端决定：中转站单独配置优先，否则全局默认
        image_payload["model"] = resolve_model(provider)
        key = provider["key"]
        mode = payload.get("mode", "text")
        endpoint = normalize_generation_endpoint(provider.get("url") or DEFAULT_GENERATION_ENDPOINT)
        logger.info("[生图 %s] 开始 中转站=%s mode=%s model=%s size=%s quality=%s n=%s key=%s… -> %s",
                    task_id[:8], provider.get("name") or "-", mode, image_payload.get("model"), image_payload.get("size"),
                    image_payload.get("quality"), image_payload.get("n"), (key or "")[:6], endpoint)
        if mode == "reference":
            endpoint = edits_endpoint_for(endpoint)
            files = [("image", (name, content, mimetype)) for name, content, mimetype in files_data]
            # 与参考项目一致：多部分表单直接 str 化参数，非流式请求
            form_data = {k: str(v) for k, v in image_payload.items()}
            response = requests.post(endpoint, headers={"Authorization": f"Bearer {key}"}, data=form_data, files=files, timeout=180)
        else:
            response = requests.post(endpoint, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=image_payload, timeout=180)
        logger.info("[生图 %s] 上游响应 HTTP %s content-type=%s 已用时 %.2fs",
                    task_id[:8], response.status_code, response.headers.get("content-type", ""), time.time() - started)
        if not response.ok:
            body = (response.text or "")[:500]
            logger.error("[生图 %s] 上游失败 HTTP %s 响应体片段: %s", task_id[:8], response.status_code, body)
            raise RuntimeError(f"生图接口返回 HTTP {response.status_code}。")
        result = _resolve_generate_result(response)
        images = normalize_images(result)
        if not images:
            try:
                preview = json.dumps(result, ensure_ascii=False)[:800]
            except Exception:
                preview = str(result)[:800]
            logger.error("[生图 %s] 上游返回 0 张图片，结果片段: %s", task_id[:8], preview)
            raise RuntimeError("上游未返回任何图片。")
        # 管理员监控缓存落盘（记录提示词与模型，方便后台审计）
        saved_ids = [save_generated_image(image, task_id, user_id, image_payload.get("prompt", ""), image_payload.get("model", "")) for image in images]
        # 任务记录只存图片引用（cached_ids），不再存 base64：
        # 原来 images 字段带完整 base64，一次 4 张 2K 图就让 image_tasks.json 涨到 8MB+，
        # 而前端每 800ms 轮询一次都要 read_tasks() 解析整份文件，纯属白烧 CPU。
        # 改成引用后任务文件只有几百字节，图片数据由监控缓存文件承载，
        # 前端通过 /api/tasks/<id>/thumb/<index> 与 /api/tasks/<id>/image/<index> 按需取。
        update_task(task_id, status="done", images=[], cached_ids=saved_ids,
                    image_count=len(images), elapsed=round(time.time() - started, 2),
                    model=image_payload["model"])
        logger.info("[生图 %s] 完成 图片数=%s 总用时 %.2fs", task_id[:8], len(images), time.time() - started)
        bump_active_provider_call()
        record_transaction(user_id, tier, count, cost_micro, "success", task_id, provider=provider_label)
    except Exception as exc:
        update_task(task_id, status="failed", error=str(exc), refunded=True)
        refund_balance(user_id, cost_micro)
        record_transaction(user_id, tier, count, cost_micro, "failed", task_id, str(exc), provider=provider_label)
        logger.error("[生图 %s] 失败并退款 $%.2f 已用时 %.2fs 错误: %s",
                     task_id[:8], cost_micro / USD_UNIT, time.time() - started, exc, exc_info=True)


@app.post("/api/tasks")
def create_task():
    payload = request.get_json(silent=True) if request.is_json else request.form.to_dict()
    payload = payload or {}
    error, _ = validate_options(payload)
    if error:
        return jsonify({"error": error}), 400
    tier = str(payload.get("tier", "1K")).upper()
    count = max(1, min(50, int(payload.get("count", 1))))
    cost_micro = int(get_prices().get(tier, 0) * USD_UNIT) * count

    # 用户身份 + 预算校验（服务端定价，不信任前端）
    user_id, cookies = _get_or_create_user()
    account = get_account(user_id)
    if account["balance"] < cost_micro:
        logger.warning("[生图] 余额不足 user=%s… 需要 $%.2f 当前余额 $%.2f",
                       user_id[:8], cost_micro / USD_UNIT, account["balance"] / USD_UNIT)
        resp = jsonify({"error": f"余额不足，本次需要 ${cost_micro / USD_UNIT:.2f}，当前余额 ${account['balance'] / USD_UNIT:.2f}。", "balance": account["balance"] / USD_UNIT})
        _attach_user_cookies(resp, cookies)
        return resp, 402
    if not deduct_balance(user_id, cost_micro):
        resp = jsonify({"error": "余额不足，请先兑换额度。"})
        _attach_user_cookies(resp, cookies)
        return resp, 402

    files_data: list[tuple[str, bytes, str]] = []
    if payload.get("mode", "text") == "reference":
        images = request.files.getlist("image")
        if not images or len(images) > 8:
            refund_balance(user_id, cost_micro)
            return jsonify({"error": "图生图需要上传 1～8 张参考图。"}), 400
        for image in images:
            if image.mimetype not in ALLOWED_IMAGE_TYPES:
                refund_balance(user_id, cost_micro)
                return jsonify({"error": "参考图仅支持 PNG、JPEG 或 WebP。"}), 400
            files_data.append((secure_filename(image.filename or "reference.png"), image.read(), image.mimetype))
    task_id = uuid.uuid4().hex
    with TASK_LOCK:
        tasks = read_tasks()
        tasks[task_id] = {"status": "queued", "created": time.time(), "images": [], "user_id": user_id}
        write_tasks(tasks)
    logger.info("[生图 %s] 新任务 user=%s… tier=%s count=%s 扣费 $%.2f",
                task_id[:8], user_id[:8], tier, count, cost_micro / USD_UNIT)
    threading.Thread(target=run_background_task, args=(task_id, payload, files_data, user_id, cost_micro, tier, count), daemon=True).start()
    resp = jsonify({"task_id": task_id, "balance": get_account(user_id)["balance"] / USD_UNIT})
    _attach_user_cookies(resp, cookies)
    return resp


@app.get("/api/tasks/<task_id>")
def get_task(task_id: str):
    with TASK_LOCK:
        task = read_tasks().get(task_id)
    if not task:
        return jsonify({"error": "任务不存在。"}), 404
    return jsonify(task)


def _task_image_id(task_id: str, index: int) -> tuple[str, Any] | tuple[None, Any]:
    """取任务第 index 张图的监控缓存 ID，并校验归属。
    返回 (image_id, error_response)；image_id 为 None 时直接把 error_response 返回给前端。"""
    with TASK_LOCK:
        task = read_tasks().get(task_id)
    if not task:
        return None, (jsonify({"error": "任务不存在。"}), 404)
    # 归属校验：只允许取自己任务的图，防止拿别人的 task_id 越权读取。
    # 用只读版本读身份，避免无 cookie 的探测请求凭空创建账户。
    user_id = _read_current_user_id()
    if not user_id or (task.get("user_id") and task["user_id"] != user_id):
        return None, (jsonify({"error": "无权访问该图片。"}), 403)
    cached_ids = task.get("cached_ids") or []
    if index < 0 or index >= len(cached_ids) or not cached_ids[index]:
        return None, (jsonify({"error": "图片不存在。"}), 404)
    return cached_ids[index], None


@app.get("/api/tasks/<task_id>/thumb/<int:index>")
def task_image_thumb(task_id: str, index: int):
    """任务图片缩略图（512px WebP，约几十 KB）。
    前端拿到 done 状态后先请求它，让节点秒出图，原图再慢慢传。"""
    image_id, error = _task_image_id(task_id, index)
    if error:
        return error
    thumb = _generated_thumb_file(image_id)
    if not thumb:
        # 缩略图生成失败（或原图已被清理）→ 退回原图，保证不出现空白
        original = _generated_path(image_id)
        if not original:
            return jsonify({"error": "图片已被清理。"}), 404
        return send_file(original, mimetype="image/png")
    return send_file(thumb, mimetype="image/webp")


@app.get("/api/tasks/<task_id>/image/<int:index>")
def task_image_full(task_id: str, index: int):
    """任务图片原图（PNG 字节流）。前端后台下载后转 base64 存 IndexedDB。"""
    image_id, error = _task_image_id(task_id, index)
    if error:
        return error
    path = _generated_path(image_id)
    if not path:
        return jsonify({"error": "图片已被清理。"}), 404
    return send_file(path, mimetype="image/png")




@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/admin")
def admin() -> str:
    return send_file(ADMIN_HTML)


@app.post("/admin/login")
def admin_login():
    data = request.get_json(silent=True) or {}
    if data.get("password", "") != admin_password():
        return jsonify({"error": "管理员密码错误。"}), 401
    return jsonify({"token": _admin_token()})


@app.post("/admin/key")
def save_key():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    key = request.json.get("key", "").strip()
    if len(key) < 10:
        return jsonify({"error": "请输入有效的生图 Key。"}), 400
    KEY_FILE.write_text(key, encoding="utf-8")
    try:
        os.chmod(KEY_FILE, 0o600)
    except OSError:
        pass
    return jsonify({"ok": True, "masked": f"{key[:4]}••••{key[-4:]}"})


@app.get("/admin/status")
def key_status():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    p = get_active_provider()
    return jsonify({
        "configured": bool(p),
        "masked": _mask_key(p.get("key")) if p else "",
        "name": p.get("name") if p else "",
    })


@app.get("/admin/prices")
def admin_get_prices():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify(get_prices())


@app.put("/admin/prices")
def admin_set_prices():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    data = request.json or {}
    new_prices: dict[str, float] = {}
    for tier in DEFAULT_PRICES:
        try:
            val = float(data.get(tier))
        except (TypeError, ValueError):
            return jsonify({"error": f"{tier} 价格无效。"}), 400
        if val < 0:
            return jsonify({"error": "价格不能为负数。"}), 400
        new_prices[tier] = round(val, 4)
    save_prices(new_prices)
    return jsonify({"ok": True, "prices": new_prices})


# ==================== 生图模型配置 ====================

@app.get("/admin/model")
def admin_get_model():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"model": get_global_model(), "default": DEFAULT_MODEL})


@app.put("/admin/model")
def admin_set_model():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    model = (request.json or {}).get("model", "").strip()
    if not model:
        return jsonify({"error": "模型 ID 不能为空。"}), 400
    if len(model) > 100:
        return jsonify({"error": "模型 ID 过长。"}), 400
    save_global_model(model)
    return jsonify({"ok": True, "model": model})


@app.post("/admin/model/test")
def admin_test_model():
    """检测指定中转站是否支持某个模型 ID。

    不实际生图（不产生费用）：请求中转站的 /v1/models，看返回列表里有没有该 ID。
    未指定 provider_id 时用当前启用的中转站。
    """
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    data = request.json or {}
    model = (data.get("model") or "").strip() or get_global_model()
    pid = (data.get("provider_id") or "").strip()

    if pid:
        provider = next((p for p in load_providers() if p.get("id") == pid), None)
        if not provider:
            return jsonify({"ok": False, "message": "指定的中转站不存在。"})
    else:
        provider = get_active_provider()
    if not provider:
        return jsonify({"ok": False, "message": "没有可用的中转站，请先添加并启用一个。"})

    url = normalize_generation_endpoint(provider.get("url") or "")
    key = provider.get("key") or ""
    if not url or not key:
        return jsonify({"ok": False, "message": "该中转站缺少 URL 或 Key。"})

    models_url = url.replace("/images/generations", "/models")
    try:
        resp = requests.get(models_url, headers={"Authorization": f"Bearer {key}"}, timeout=15)
    except requests.RequestException as exc:
        return jsonify({"ok": False, "message": f"无法连接中转站：{exc}"})

    if resp.status_code in (401, 403):
        return jsonify({"ok": False, "message": f"认证失败（HTTP {resp.status_code}），请检查 Key。"})
    if resp.status_code == 404:
        return jsonify({"ok": False, "message": "该中转站未提供模型列表接口，无法自动检测，请直接生图验证。",
                        "models": [], "model": model})
    if resp.status_code != 200:
        return jsonify({"ok": False, "message": f"返回异常状态 HTTP {resp.status_code}。"})

    models: list[str] = []
    try:
        payload = resp.json()
        raw = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(raw, list):
            models = [m.get("id") for m in raw if isinstance(m, dict) and m.get("id")]
    except ValueError:
        pass

    if not models:
        return jsonify({"ok": True, "exists": None, "model": model, "models": [],
                        "message": "连通正常，但中转站未返回模型列表，无法确认是否支持该模型。"})

    exists = model in models
    return jsonify({
        "ok": True,
        "exists": exists,
        "model": model,
        "models": models,
        "message": (f"该中转站支持 {model}。" if exists
                    else f"该中转站不支持 {model}，请从下方列表里选一个。"),
    })


@app.get("/admin/announcement")
def admin_get_announcement():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"text": get_announcement_text()})


@app.put("/admin/announcement")
def admin_set_announcement():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    text = (request.json or {}).get("text", "").strip()
    save_announcement_text(text)
    return jsonify({"ok": True})


@app.get("/admin/purchase")
def admin_get_purchase():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"url": get_purchase_url()})


@app.put("/admin/purchase")
def admin_set_purchase():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    url = (request.json or {}).get("url", "").strip()
    save_purchase_url(url)
    return jsonify({"ok": True})


# ==================== 中转站管理（可配置多个，勾选启用） ====================

def _slim_provider(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": p.get("id"),
        "name": p.get("name", ""),
        "url": p.get("url", ""),
        "has_key": bool(p.get("key")),
        "key_masked": _mask_key(p.get("key")),
        "note": p.get("note", ""),
        "active": bool(p.get("active")),
        "calls": int(p.get("calls", 0) or 0),
        # 该中转站单独指定的模型；空字符串表示用全局默认
        "model": p.get("model", ""),
    }


@app.get("/admin/providers")
def list_providers():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"list": [_slim_provider(p) for p in load_providers()]})


@app.post("/admin/providers")
def add_provider():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    data = request.json or {}
    url = (data.get("url") or "").strip()
    key = (data.get("key") or "").strip()
    if not url or not key:
        return jsonify({"error": "中转站地址 (URL) 和 API Key 均为必填。"}), 400
    providers = load_providers()
    has_active = any(p.get("active") for p in providers)
    # 名称按顺序自动生成：中转站1、中转站2…
    name = f"中转站{len(providers) + 1}"
    pid = str(uuid.uuid4())
    providers.append({
        "id": pid, "name": name, "url": url, "key": key,
        "note": "", "active": not has_active, "calls": 0,
        "model": (data.get("model") or "").strip(),
    })
    save_providers(providers)
    return jsonify({"ok": True, "id": pid})


@app.put("/admin/providers/<pid>")
def update_provider(pid):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    data = request.json or {}
    providers = load_providers()
    for p in providers:
        if p.get("id") == pid:
            if "name" in data:
                p["name"] = (data.get("name") or "").strip() or p.get("name", "")
            if "url" in data:
                p["url"] = (data.get("url") or "").strip()
            if data.get("key"):
                p["key"] = data.get("key").strip()
            if "note" in data:
                p["note"] = (data.get("note") or "").strip()
            if "model" in data:
                p["model"] = (data.get("model") or "").strip()
            if not p.get("url") or not p.get("key"):
                save_providers(providers)
                return jsonify({"error": "中转站缺失 URL 或 Key。"}), 400
            save_providers(providers)
            return jsonify({"ok": True})
    return jsonify({"error": "中转站不存在。"}), 404


@app.get("/admin/providers/<pid>/key")
def reveal_provider_key(pid):
    """返回中转站的完整 Key，仅供后台「复制」按钮使用；列表接口始终只给掩码。"""
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    provider = next((p for p in load_providers() if p.get("id") == pid), None)
    if not provider:
        return jsonify({"error": "中转站不存在。"}), 404
    key = provider.get("key") or ""
    if not key:
        return jsonify({"error": "该中转站未配置 Key。"}), 404
    return jsonify({"key": key})


@app.post("/admin/providers/<pid>/note")
def update_provider_note(pid):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    note = (request.json or {}).get("note", "").strip()
    providers = load_providers()
    for p in providers:
        if p.get("id") == pid:
            p["note"] = note
            save_providers(providers)
            return jsonify({"ok": True})
    return jsonify({"error": "中转站不存在。"}), 404


@app.post("/admin/providers/<pid>/activate")
def activate_provider(pid):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    providers = load_providers()
    found = False
    for p in providers:
        p["active"] = (p.get("id") == pid)
        if p.get("id") == pid and p.get("key"):
            found = True
    if not found:
        return jsonify({"error": "中转站不存在或未配置 Key。"}), 404
    save_providers(providers)
    return jsonify({"ok": True})


@app.delete("/admin/providers/<pid>")
def delete_provider(pid):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    providers = load_providers()
    removed = [p for p in providers if p.get("id") == pid]
    providers = [p for p in providers if p.get("id") != pid]
    # 若删除的是启用项，则自动把剩余第一条设为启用
    if removed and removed[0].get("active") and providers:
        providers[0]["active"] = True
    save_providers(providers)
    return jsonify({"ok": True})


@app.post("/admin/providers/<pid>/test")
def test_provider(pid):
    """只做连通性与认证探测，不实际生成图片，因此不扣费。

    做法：请求该中转站的模型列表接口（OpenAI 兼容的 /v1/models），
    不带任何生成参数，用返回状态判断地址是否可达、Key 是否有效。
    """
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    provider = next((p for p in load_providers() if p.get("id") == pid), None)
    if not provider:
        return jsonify({"error": "中转站不存在。"}), 404
    url = normalize_generation_endpoint(provider.get("url") or "")
    key = provider.get("key") or ""
    if not url or not key:
        return jsonify({"ok": False, "message": "中转站缺少 URL 或 Key。"})
    models_url = url.replace("/images/generations", "/models")
    try:
        resp = requests.get(models_url, headers={"Authorization": f"Bearer {key}"}, timeout=15)
    except requests.RequestException as exc:
        return jsonify({"ok": False, "message": f"无法连接中转站：{exc}"})
    if resp.status_code == 200:
        # 用真实 Key 查询该中转站支持的所有模型，并返回名称列表
        models = []
        try:
            data = resp.json()
            raw = data.get("data") if isinstance(data, dict) else None
            if isinstance(raw, list):
                models = [m.get("id") for m in raw if isinstance(m, dict) and m.get("id")]
        except ValueError:
            pass
        if models:
            return jsonify({"ok": True, "message": f"连通正常，认证通过，支持 {len(models)} 个模型", "models": models})
        return jsonify({"ok": True, "message": "连通正常，认证通过（未返回模型列表）", "models": []})
    if resp.status_code in (401, 403):
        return jsonify({"ok": False, "message": f"认证失败（HTTP {resp.status_code}），请检查 Key"})
    if resp.status_code == 404:
        return jsonify({"ok": True, "message": "地址可达，但该站未提供模型列表接口，需实际生图验证", "models": []})
    return jsonify({"ok": False, "message": f"返回异常状态 HTTP {resp.status_code}"})


@app.post("/api/generate")
def generate():
    # 该同步接口不计费、不走任务队列，仅保留给管理员调试用，必须鉴权
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    provider = get_active_provider()
    if not provider:
        return jsonify({"error": "服务端尚未配置可用的生图中转站，请联系管理员。"}), 503
    key = provider["key"]

    payload = request.get_json(silent=True) if request.is_json else request.form.to_dict()
    payload = payload or {}
    error, image_payload = validate_options(payload)
    if error:
        return jsonify({"error": error}), 400

    # 模型由服务端决定，忽略前端传值
    image_payload["model"] = resolve_model(provider)
    mode = payload.get("mode", "text")
    endpoint = normalize_generation_endpoint(provider.get("url") or DEFAULT_GENERATION_ENDPOINT)
    logger.info("[生成同步] 中转站=%s mode=%s -> %s", provider.get("name") or "-", mode, endpoint)
    files = None
    if mode == "reference":
        endpoint = edits_endpoint_for(endpoint)
        images = request.files.getlist("image")
        if not images or len(images) > 8:
            return jsonify({"error": "图生图需要上传 1～8 张参考图。"}), 400
        files = []
        for image in images:
            if image.mimetype not in ALLOWED_IMAGE_TYPES:
                return jsonify({"error": "参考图仅支持 PNG、JPEG 或 WebP。"}), 400
            files.append(("image", (secure_filename(image.filename or "reference.png"), image.stream, image.mimetype)))
        form_payload = {key: str(value) for key, value in image_payload.items()}
        form_payload["stream"] = "false"
        try:
            response = requests.post(endpoint, headers={"Authorization": f"Bearer {key}"}, data=form_payload, files=files, timeout=180)
        except requests.RequestException as exc:
            return jsonify({"error": f"上游请求失败：{exc}"}), 502
    else:
        try:
            response = requests.post(endpoint, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=image_payload, timeout=180)
        except requests.RequestException as exc:
            return jsonify({"error": f"上游请求失败：{exc}"}), 502

    if not response.ok:
        return jsonify({"error": f"生图接口返回 HTTP {response.status_code}。", "detail": response.text[:1000]}), response.status_code
    try:
        result = response.json()
    except ValueError:
        return jsonify({"error": "上游返回了无法解析的响应。"}), 502
    return jsonify({"images": normalize_images(result), "raw": {"created": result.get("created")}})


@app.get("/api/prices")
def prices():
    return jsonify(get_prices())


@app.get("/api/announcement")
def get_announcement():
    return jsonify({"text": get_announcement_text()})


@app.get("/api/purchase")
def get_purchase():
    return jsonify({"url": get_purchase_url()})


# ==================== 用户端接口 ====================

@app.post("/api/identify")
def identify():
    user_id, cookies = _get_or_create_user()
    account = get_account(user_id)
    resp = jsonify({"user_id": user_id, "balance": account["balance"] / USD_UNIT})
    _attach_user_cookies(resp, cookies)
    return resp


@app.get("/api/balance")
def balance():
    user_id, cookies = _get_or_create_user()
    account = get_account(user_id)
    resp = jsonify({"user_id": user_id, "balance": account["balance"] / USD_UNIT,
                    "recharged": account["recharged"] / USD_UNIT, "spent": account["spent"] / USD_UNIT,
                    "usage": account["usage"]})
    _attach_user_cookies(resp, cookies)
    return resp


@app.post("/api/redeem")
def redeem():
    user_id, cookies = _get_or_create_user()
    code = (request.get_json(silent=True) or {}).get("code", "")
    ok, message = redeem_code(code, user_id)
    account = get_account(user_id)
    resp = jsonify({"ok": ok, "message": message, "balance": account["balance"] / USD_UNIT})
    _attach_user_cookies(resp, cookies)
    return (resp, 400) if not ok else resp


# ==================== 管理端接口（激活码 / 账户 / 流水 / 监控缓存） ====================

@app.post("/api/admin/codes")
def create_codes():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    data = request.get_json(silent=True) or {}
    try:
        count = max(1, min(200, int(data.get("count", 1))))
        amount_usd = float(data.get("amount", 1))
    except (TypeError, ValueError):
        return jsonify({"error": "参数无效。"}), 400
    amount_micro = int(round(amount_usd * USD_UNIT))
    if amount_micro <= 0:
        return jsonify({"error": "额度必须大于 0。"}), 400
    now = time.time()
    codes = load_codes()
    created = []
    for _ in range(count):
        code = _gen_code(codes)
        rec = {"code": code, "amount_micro": amount_micro, "enabled": True,
               "created_at": now, "redeemed_at": None, "redeemed_by": None}
        codes.append(rec)
        created.append(code)
    save_codes(codes)
    return jsonify({"codes": created, "amount_usd": amount_usd})


@app.get("/api/admin/codes")
def list_codes():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"codes": load_codes()})


@app.post("/api/admin/codes/<code>/toggle")
def toggle_code(code: str):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    enabled = bool((request.get_json(silent=True) or {}).get("enabled", False))
    codes = load_codes()
    target = next((c for c in codes if c.get("code") == code), None)
    if not target:
        return jsonify({"error": "激活码不存在。"}), 404
    target["enabled"] = enabled
    save_codes(codes)
    return jsonify({"ok": True, "enabled": enabled})


@app.post("/api/admin/codes/<code>/extend")
def extend_code(code: str):
    """追加额度：未兑换码直接加额度；已兑换码把额度加到绑定用户的余额。"""
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    data = request.get_json(silent=True) or {}
    try:
        amount_usd = float(data.get("amount", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "参数无效。"}), 400
    amount_micro = int(round(amount_usd * USD_UNIT))
    if amount_micro <= 0:
        return jsonify({"error": "额度必须大于 0。"}), 400
    codes = load_codes()
    target = next((c for c in codes if c.get("code") == code), None)
    if not target:
        return jsonify({"error": "激活码不存在。"}), 404
    if target.get("redeemed_at"):
        user_id = target.get("redeemed_by", "")
        _update_account(user_id, lambda a: a.update({"balance": a["balance"] + amount_micro, "recharged": a["recharged"] + amount_micro}))
        record_transaction(user_id, "Extend", 1, amount_micro, "recharge")
    else:
        target["amount_micro"] = target.get("amount_micro", 0) + amount_micro
        save_codes(codes)
    return jsonify({"ok": True})


@app.delete("/api/admin/codes/<code>")
def delete_code(code: str):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    codes = load_codes()
    cleaned = [c for c in codes if c.get("code") != code]
    if len(cleaned) == len(codes):
        return jsonify({"error": "激活码不存在。"}), 404
    save_codes(cleaned)
    return jsonify({"ok": True})


@app.get("/api/admin/stats")
def admin_stats():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    codes = load_codes()
    accounts = load_accounts()
    total_redeemed = sum(1 for c in codes if c.get("redeemed_at"))
    total_balance = sum(a.get("balance", 0) for a in accounts.values())
    total_spent = sum(a.get("spent", 0) for a in accounts.values())
    total_usage = sum(a.get("usage", 0) for a in accounts.values())
    return jsonify({
        "codes_total": len(codes), "codes_unused": len(codes) - total_redeemed,
        "codes_redeemed": total_redeemed,
        "accounts": len(accounts), "total_balance": total_balance / USD_UNIT,
        "total_spent": total_spent / USD_UNIT, "total_usage": total_usage,
    })


@app.get("/api/admin/transactions")
def admin_transactions():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"transactions": load_transactions()[-500:][::-1]})


@app.get("/api/admin/generated")
def admin_generated():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    records = _read_json(GENERATED_INDEX, [])
    records = sorted(records, key=lambda item: item.get("created", 0), reverse=True)
    total_bytes = 0
    for item in records:
        # 每张图带上文件体积，后台卡片要显示；顺便累计总占用
        try:
            size = (GENERATED_DIR / item.get("file", "")).stat().st_size
            item["bytes"] = size
            total_bytes += size
        except OSError:
            item["bytes"] = 0
    return jsonify({"total": len(records), "limit": get_cache_limit(), "bytes": total_bytes, "list": records})


@app.get("/admin/cache-limit")
def admin_get_cache_limit():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    return jsonify({"limit": get_cache_limit(), "default": DEFAULT_CACHE_LIMIT, "max": MAX_CACHE_LIMIT})


@app.put("/admin/cache-limit")
def admin_set_cache_limit():
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    try:
        limit = int((request.json or {}).get("limit"))
    except (TypeError, ValueError):
        return jsonify({"error": "请输入有效数字。"}), 400
    if limit < 1 or limit > MAX_CACHE_LIMIT:
        return jsonify({"error": f"范围应在 1 ~ {MAX_CACHE_LIMIT} 之间。"}), 400
    saved = save_cache_limit(limit)
    # 调小上限时立即裁掉多余的最旧记录，避免磁盘继续占着
    result = purge_generated(keep=saved)
    return jsonify({"ok": True, "limit": saved, "removed": result["removed"], "freed_bytes": result["freed_bytes"]})


@app.post("/api/admin/generated/purge")
def admin_generated_purge():
    """一键清空监控缓存：真删磁盘文件并重建索引。"""
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    result = purge_generated(keep=0)
    logger.info("[监控缓存] 已清空 %s 张，释放 %.2f MB", result["removed"], result["freed_bytes"] / 1024 / 1024)
    return jsonify({"ok": True, "removed": result["removed"], "freed_bytes": result["freed_bytes"]})


@app.get("/api/admin/generated/<image_id>")
def admin_generated_image(image_id: str):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    records = _read_json(GENERATED_INDEX, [])
    item = next((x for x in records if x.get("id") == image_id), None)
    if not item:
        return jsonify({"error": "图片不存在或已被淘汰。"}), 404
    path = GENERATED_DIR / item.get("file", "")
    if not path.exists():
        return jsonify({"error": "图片文件不存在。"}), 404
    return send_file(path, mimetype="image/png")


@app.get("/api/admin/generated/<image_id>/thumb")
def admin_generated_thumb(image_id: str):
    """监控图缩略图：首次请求生成 WebP 缓存，之后直接读缓存，避免列表拉几 MB 原图。"""
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    records = _read_json(GENERATED_INDEX, [])
    item = next((x for x in records if x.get("id") == image_id), None)
    if not item:
        return jsonify({"error": "图片不存在或已被淘汰。"}), 404
    src = GENERATED_DIR / item.get("file", "")
    if not src.exists():
        return jsonify({"error": "图片文件不存在。"}), 404

    thumb = GENERATED_THUMB_DIR / f"{image_id}.webp"
    if not thumb.exists():
        try:
            with Image.open(src) as im:
                im = im.convert("RGB")
                im.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.LANCZOS)
                im.save(thumb, "WEBP", quality=82, method=4)
        except (OSError, ValueError) as exc:
            logger.warning("[缩略图] 生成失败 %s: %s", image_id[:8], exc)
            return send_file(src, mimetype="image/png")  # 生成失败就退回原图
    return send_file(thumb, mimetype="image/webp")


@app.delete("/api/admin/generated/<image_id>")
def admin_generated_delete(image_id: str):
    if not require_admin():
        return jsonify({"error": "未授权。"}), 401
    with _IO_LOCK:
        records = _read_json(GENERATED_INDEX, [])
        item = next((x for x in records if x.get("id") == image_id), None)
        if not item:
            return jsonify({"error": "图片不存在。"}), 404
        (GENERATED_DIR / item.get("file", "")).unlink(missing_ok=True)
        (GENERATED_THUMB_DIR / f"{image_id}.webp").unlink(missing_ok=True)
        _write_json(GENERATED_INDEX, [x for x in records if x.get("id") != image_id])
    return jsonify({"ok": True})


ensure_data()

if __name__ == "__main__":
    _start_task_cleanup_worker()
    # debug 由环境变量控制，默认关闭。
    # 开着 debug 会多起一个 reloader 监控进程（内存翻倍），并暴露 Werkzeug 调试器（可执行任意代码），
    # 生产环境绝不能开。本地调试需要自动重载时：PowerShell 里 $env:FLASK_DEBUG=1 再启动。
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")),
            debug=os.environ.get("FLASK_DEBUG", "") == "1")
