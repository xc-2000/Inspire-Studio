/** Missing availability means a direct channel; an empty list means no active route. */
export function availableChannelModels(channel: { models: string[]; availableModels?: string[] | null }): string[] {
    if (!Array.isArray(channel.availableModels)) return channel.models;
    const available = new Set(channel.availableModels);
    return channel.models.filter((model) => available.has(model));
}
