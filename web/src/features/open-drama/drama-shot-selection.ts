export type DramaShotSelection = { boardId: string; shotIds: string[] };
type ShotIdentity = { id: string };

/** Keep selection scoped to its board, and always resolve IDs against live shots. */
export function readDramaShotSelection(boardId: string | undefined, shots: readonly ShotIdentity[], selection: DramaShotSelection | null): string[] {
    if (!boardId || selection?.boardId !== boardId) return [];
    const selected = new Set(selection.shotIds);
    return [...new Set(shots.filter(shot => selected.has(shot.id)).map(shot => shot.id))];
}

/** Page/filter toggles change only their targets and retain selections on other pages. */
export function updateDramaShotSelection(boardId: string, shots: readonly ShotIdentity[], selection: DramaShotSelection | null, targetIds: readonly string[], checked: boolean): DramaShotSelection {
    const selected = new Set(readDramaShotSelection(boardId, shots, selection));
    for (const id of targetIds) {
        if (checked) selected.add(id);
        else selected.delete(id);
    }
    return { boardId, shotIds: readDramaShotSelection(boardId, shots, { boardId, shotIds: [...selected] }) };
}
