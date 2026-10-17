/** Filter before pagination; unknown or mismatched types never enter a creation page. */
export function filterSkillsForTarget<T extends { targetType: string }>(skills: T[], targetType: string): T[] {
    return skills.filter((skill) => skill.targetType === targetType);
}
