import { NextRequest, NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";

// 允许自定义接口地址(反代);宽容处理末尾 / 与误带的 /v1
function normalizeFishBaseUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FISH_BASE_URL;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProto.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

// 密钥解析优先级:请求体 apiKey → Authorization 头 → 服务端 FISH_AUDIO_API_KEY 兜底。
// 服务端兜底让自部署时前端无需持有 key,key 不暴露到浏览器(与 TTS 路由约定一致)。
function resolveApiKey(req: NextRequest, bodyKey?: string): string | null {
  if (bodyKey && String(bodyKey).trim()) return String(bodyKey).trim();
  const auth = req.headers.get("authorization");
  if (auth) {
    const cleaned = auth.replace(/^Bearer\s+/i, "").trim();
    if (cleaned) return cleaned;
  }
  const envKey = process.env.FISH_AUDIO_API_KEY;
  return envKey && envKey.trim() ? envKey.trim() : null;
}

const isFileLike = (v: unknown): v is Blob =>
  typeof v === "object" && v !== null && typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function";

// POST /api/voice/fish-audio/model — 音色克隆(代理 Fish Audio POST /model)
// 客户端上传音频 + apiKey + baseUrl,服务端转发 multipart 到 Fish Audio,密钥不出服务端。
// 注:服务端中转对大文件依赖部署平台的请求体上限;如部署在严格受限的函数环境,
// 可考虑改为浏览器直连(与 Minimax 克隆同路),此处优先保证密钥不落前端。
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json(
        { error: "bad_form", message: "请求体应为 multipart/form-data" },
        { status: 400 },
      );
    }

    const rawFile = form.get("file");
    const title = typeof form.get("title") === "string" ? (form.get("title") as string).trim() : "";
    const apiKey = typeof form.get("apiKey") === "string" ? (form.get("apiKey") as string) : null;
    const baseUrl = typeof form.get("baseUrl") === "string" ? (form.get("baseUrl") as string) : null;

    const token = resolveApiKey(req, apiKey);
    if (!token) {
      return NextResponse.json(
        {
          error: "missing_api_key",
          message:
            "缺少 Fish Audio API Key：可在请求体传 apiKey，或在服务端配置 FISH_AUDIO_API_KEY 环境变量",
        },
        { status: 401 },
      );
    }
    if (!isFileLike(rawFile)) {
      return NextResponse.json({ error: "missing_file", message: "请上传音频样本文件" }, { status: 400 });
    }
    const file = rawFile;

    const fishBase = normalizeFishBaseUrl(baseUrl);
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName =
      "name" in file && typeof (file as { name?: unknown }).name === "string" && (file as { name: string }).name
        ? (file as { name: string }).name
        : "voice-sample.mp3";

    // Fish Audio 克隆接口字段:type=tts,title,train_mode=fast,visibility=private,voices=@file
    const upstream = new FormData();
    upstream.set("type", "tts");
    upstream.set("title", title || "Cloned Voice");
    upstream.set("train_mode", "fast");
    upstream.set("visibility", "private");
    upstream.append("voices", new Blob([buffer], { type: file.type || "audio/mpeg" }), fileName);

    const fishRes = await proxyFetch(`${fishBase}/model`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: upstream,
    });

    const text = await fishRes.text().catch(() => "");
    if (!fishRes.ok) {
      const status = fishRes.status === 401 ? 401 : 502;
      return NextResponse.json(
        {
          error: "fish_clone_error",
          message: `Fish Audio 克隆失败 (${fishRes.status}): ${text.slice(0, 500)}`,
        },
        { status },
      );
    }

    let data: Record<string, any> = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
    // 响应同时带 _id(JS SDK)与 id(Python SDK),取其一作为 Reference ID
    const referenceId = data?._id ?? data?.id ?? null;
    if (!referenceId) {
      return NextResponse.json(
        {
          error: "no_reference_id",
          message: `克隆已返回但未携带 Reference ID: ${text.slice(0, 300)}`,
          raw: data,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      referenceId,
      state: data?.state ?? null,
      title: data?.title ?? title,
      raw: data,
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    // 本地 dev 出网失败(需代理)、上游超时等都带上原因返回,避免裸 500
    return NextResponse.json({ error: "clone_failed", message: message.slice(0, 500) }, { status: 502 });
  }
}
