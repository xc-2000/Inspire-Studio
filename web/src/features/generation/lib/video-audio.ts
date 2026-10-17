/** Reference audio takes precedence without changing the user's saved preference. */
export function videoGenerateAudio(value: unknown, audioReferenceCount = 0): boolean {
    if (audioReferenceCount > 0) return false;
    if (value === false || value === 0) return false;
    return !["false", "0"].includes(String(value ?? "true").trim().toLowerCase());
}
