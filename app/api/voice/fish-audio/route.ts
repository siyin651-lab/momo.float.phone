import { NextRequest, NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 60;

const FISH_AUDIO_TTS_PATH = "/v1/tts";
const FISH_AUDIO_MODEL_PATH = "/v1/model";
const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";

// 允许自定义接口地址（反代）；宽容处理末尾 / 与误带的 /v1
function normalizeFishBaseUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FISH_BASE_URL;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProto.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

// 密钥解析优先级:请求体 apiKey → Authorization 头 → 服务端 FISH_AUDIO_API_KEY 兜底。
// 服务端兜底让自部署时前端无需持有 key,key 不暴露到浏览器(与仓库 TRIPO/IMGBB 约定一致)。
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

function audioContentType(format: string): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "pcm":
      return "audio/pcm";
    case "flac":
      return "audio/flac";
    default:
      return "audio/mpeg";
  }
}

// POST /api/voice/fish-audio — 文本合成语音(代理 Fish Audio TTS v1)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    const {
      text,
      reference_id,
      apiKey,
      format = "mp3",
      mp3_bitrate = 128,
      normalize = true,
      latency = "normal",
      stream = false,
      model,
      baseUrl,
    } = body;

    const fishBase = normalizeFishBaseUrl(baseUrl);

    const token = resolveApiKey(req, apiKey);
    if (!token) {
      return NextResponse.json(
        {
          error: "missing_api_key",
          message:
            "缺少 Fish Audio API Key：可在请求体传 apiKey、在 Authorization 头配置 Bearer，或在服务端配置 FISH_AUDIO_API_KEY 环境变量",
        },
        { status: 401 },
      );
    }

    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "missing_text", message: "text 为必填项且不能为空" },
        { status: 400 },
      );
    }

    const fishRes = await proxyFetch(`${fishBase}${FISH_AUDIO_TTS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Fish Audio 用 model 请求头选择模型（s2.1-pro / s2.1-pro-free / s2-pro / s1）
        ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
      },
      body: JSON.stringify({
        text,
        reference_id: reference_id || undefined,
        format,
        mp3_bitrate,
        normalize,
        latency,
        stream: Boolean(stream),
      }),
    });

    if (!fishRes.ok) {
      const errText = await fishRes.text().catch(() => "");
      const status = fishRes.status === 401 ? 401 : 502;
      return NextResponse.json(
        {
          error: "fish_audio_error",
          message: `Fish Audio 接口错误 (${fishRes.status}): ${errText.slice(0, 500)}`,
        },
        { status },
      );
    }

    const audioBuffer = await fishRes.arrayBuffer();
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": audioContentType(format),
        "Content-Length": String(audioBuffer.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    // 本地 dev 出网失败(需代理)、上游超时等都带上原因返回,避免裸 500
    return NextResponse.json(
      { error: "synthesis_failed", message: message.slice(0, 500) },
      { status: 502 },
    );
  }
}

// GET /api/voice/fish-audio?reference_id=xxx — 校验/获取声音(模型)元数据
export async function GET(req: NextRequest) {
  const reference_id = req.nextUrl.searchParams.get("reference_id");
  const baseUrl = req.nextUrl.searchParams.get("baseUrl");
  const token = resolveApiKey(req);
  if (!token) {
    return NextResponse.json(
      { error: "missing_api_key", message: "缺少 Fish Audio API Key" },
      { status: 401 },
    );
  }
  if (!reference_id || !reference_id.trim()) {
    return NextResponse.json(
      { error: "missing_reference_id", message: "请提供 reference_id 查询模型信息" },
      { status: 400 },
    );
  }

  try {
    const res = await proxyFetch(`${normalizeFishBaseUrl(baseUrl)}${FISH_AUDIO_MODEL_PATH}/${reference_id.trim()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const status = res.status === 401 ? 401 : 502;
      return NextResponse.json(
        {
          error: "model_lookup_failed",
          message: `Fish Audio 模型查询失败 (${res.status}): ${text.slice(0, 500)}`,
        },
        { status },
      );
    }
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return NextResponse.json(data);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "model_lookup_failed", message: message.slice(0, 500) },
      { status: 502 },
    );
  }
}
