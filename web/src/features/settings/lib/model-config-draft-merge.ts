type ModelConfigIdentity = {
    id: string;
    channelId: string;
    modelName: string;
    modelType: string;
};

function modelConfigNaturalKey(config: ModelConfigIdentity) {
    return JSON.stringify([config.channelId, config.modelName, config.modelType]);
}

/** A hidden disabled model is not a deselected model. Keep its prices, alias and default flag. */
export function retainCapabilityModelDrafts<T extends ModelConfigIdentity>(configs: readonly T[], capability: string,
    selectedValues: readonly string[], availableValues: readonly string[]): T[] {
    const selected = new Set(selectedValues);
    const available = new Set(availableValues);
    return configs.filter((config) => config.modelType === capability
        && (selected.has(`${config.channelId}::${config.modelName}`) || !available.has(`${config.channelId}::${config.modelName}`)));
}

/**
 * Reuses server IDs for drafts that represent an already persisted model.
 * All editable draft fields are retained so a retry applies the user's latest values.
 */
export function reconcileModelConfigDraftIds<T extends ModelConfigIdentity>(drafts: readonly T[], persisted: readonly ModelConfigIdentity[]): T[] {
    const persistedByNaturalKey = new Map(persisted.map((config) => [modelConfigNaturalKey(config), config.id]));
    return drafts.map((draft) => {
        const persistedId = persistedByNaturalKey.get(modelConfigNaturalKey(draft));
        return persistedId && persistedId !== draft.id ? { ...draft, id: persistedId } : draft;
    });
}
