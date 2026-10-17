/** 语音合成的共享常量：不依赖服务端客户端，便于剧情规划与画布节点共用。 */

/** 常用音色（xAI Grok Voice）；其他供应商可直接输入自己的音色名。 */
export const SPEECH_VOICE_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "eve", label: "Eve · 活力明亮（默认）" },
    { value: "ara", label: "Ara · 温暖亲和" },
    { value: "luna", label: "Luna · 耐心温柔" },
    { value: "carina", label: "Carina · 轻柔安抚" },
    { value: "iris", label: "Iris · 开朗可爱" },
    { value: "sal", label: "Sal · 平稳自然" },
    { value: "rex", label: "Rex · 自信清晰" },
    { value: "leo", label: "Leo · 权威沉稳" },
    { value: "orion", label: "Orion · 电影感旁白" },
    { value: "zagan", label: "Zagan · 戏剧张力" },
    { value: "sirius", label: "Sirius · 俏皮机灵" },
    { value: "lux", label: "Lux · 沉静内敛" },
];
export const DEFAULT_SPEECH_VOICE = "eve";
/** 与服务端单段上限保持一致。 */
export const MAX_SPEECH_TEXT_LENGTH = 4000;

