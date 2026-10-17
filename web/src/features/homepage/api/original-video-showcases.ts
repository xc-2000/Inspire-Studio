import type { HomepageShowcase } from "@/services/api/server";

export type HomepageVideoShowcase = HomepageShowcase & { fullVideoUrl?: string; visualStyle?: string };

// Content is managed by each deployment. No generated films are bundled with source.
export const homepageOriginalShowcases: HomepageVideoShowcase[] = [];
