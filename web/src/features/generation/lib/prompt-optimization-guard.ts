/**
 * 提示词优化结果校验。
 *
 * 优化模型偶尔会无视"只返回优化后的提示词正文"的约束，返回自述能力、
 * 罗列多个版本或反问用户的聊天式回复。这类文本一旦被当作生成提示词，
 * 会直接污染上游渠道，因此需要统一的判定逻辑。
 *
 * 判定规则与服务端 PromptOptimizationService.looksLikeConversationalReply 保持一致。
 */

/** 对话式回复特征：优化模型自述能力、罗列多个版本、反问用户等。 */
const CONVERSATIONAL_REPLY_PATTERN = /我没有|我无法|我不能生成|以下已按|以下是我|可供选择|请选择|需要我|你需要我|要哪一种|哪一种|可供投喂|参数建议|使用建议|备注：|说明：|选择建议|你是想|告诉我意图|我再动手|I cannot|I can't|As an AI|Would you like|Here are/i;

/** Markdown 结构特征：优化结果只应是提示词正文，不应出现标题或分隔线。 */
const MARKDOWN_STRUCTURE_PATTERN = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*$|```|>\s+\S|\|.*\|\s*$)/;

/** 优化结果的长度上限，超出视为模型未按提示词正文输出。 */
const MAXIMUM_OPTIMIZED_PROMPT_LENGTH = 4000;

/**
 * 判断优化结果是否疑似对话式回复而非提示词正文。
 *
 * @param text 优化结果
 * @returns 疑似对话式回复时返回 true
 */
export function looksLikeConversationalReply(text: string) {
    if (!text || !text.trim()) return false;
    if (text.length > MAXIMUM_OPTIMIZED_PROMPT_LENGTH) return true;
    if (CONVERSATIONAL_REPLY_PATTERN.test(text)) return true;
    const markerCount = text.split("\n").filter((line) => MARKDOWN_STRUCTURE_PATTERN.test(line)).length;
    return markerCount >= 2;
}

/**
 * 从文本任务结果中读取并清理优化后的提示词。
 *
 * @param resultData 文本任务结果
 * @returns 清理后的提示词，缺失或为对话式回复时返回空串
 */
export function readOptimizedPrompt(resultData: unknown) {
    if (!resultData || typeof resultData !== "object") return "";
    const content = (resultData as { content?: unknown }).content;
    if (typeof content !== "string") return "";
    const cleaned = content.trim().replace(/^```[\w-]*\s*/, "").replace(/```$/, "").trim();
    return looksLikeConversationalReply(cleaned) ? "" : cleaned;
}
