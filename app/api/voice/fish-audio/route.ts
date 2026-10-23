import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      text,
      reference_id,
      apiKey,
      format = "mp3",
      mp3_bitrate = 128,
      normalize = true,
      latency = "normal",
    } = body;

    const token = apiKey || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    if (!token) {
      return NextResponse.json(
        { error: "缺少 API Key：请在请求体中传入 apiKey 或在 Authorization header 中配置 Bearer Token" },
        { status: 401 }
      );
    }

    if (!text) {
      return NextResponse.json(
        { error: "缺少合成文本：text 为必填项" },
        { status: 400 }
      );
    }

    // 调用 Fish Audio TTS API (v1)
    const fishRes = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        reference_id: reference_id || undefined,
        format,
        mp3_bitrate,
        normalize,
        latency,
      }),
    });

    if (!fishRes.ok) {
      const errText = await fishRes.text();
      return NextResponse.json(
        { error: `Fish Audio 接口错误 (${fishRes.status}): ${errText}` },
        { status: fishRes.status }
      );
    }

    const audioBuffer = await fishRes.arrayBuffer();
    const contentType = format === "wav" ? "audio/wav" : format === "opus" ? "audio/opus" : "audio/mpeg";

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": audioBuffer.byteLength.toString(),
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "合成请求处理失败" },
      { status: 500 }
    );
  }
}
