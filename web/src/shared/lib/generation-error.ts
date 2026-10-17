/** Convert known provider failures to actionable copy without masking unrelated errors. */
export function formatGenerationError(message: string | null | undefined): string {
    const text = message?.trim() || "生成失败";
    if (/task user quota exceed/i.test(text)) {
        return text.replace(/task user quota exceed[^\n]*/i, "上游账号生成配额已用尽，请检查渠道额度后重试");
    }
    if (/Upstream video generation did not complete/i.test(text)) {
        return text.replace(/Upstream video generation did not complete/gi, "上游视频任务生成失败，未返回成片");
    }
    // AutoDL wraps a failed reference download as an invalid/nonexistent URL.
    // Its nested timeout is the actual cause; a missing file has no timeout here.
    if (/\bref_image_\d+\b/i.test(text) && /(?:\btimeout\b|\btimed\s*out\b|context deadline exceeded)/i.test(text)) {
        const retryPrefix = text.match(/^自动重试\s*3\s*次后仍失败[：:]\s*/)?.[0] || "";
        return `${retryPrefix}视频渠道读取参考图片超时，请重试`;
    }
    return text;
}
