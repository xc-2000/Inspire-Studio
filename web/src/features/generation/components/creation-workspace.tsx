"use client";

import { useState } from "react";
import { Button, Drawer, Grid } from "antd";
import { ImagePlus, PanelLeft, Plus, Video } from "lucide-react";
import styles from "./creation-workspace.module.css";

import { CreationComposer } from "@/features/generation/components/creation-composer";
import { CreationConversationSidebar } from "@/features/generation/components/creation-conversation-sidebar";
import { CreationMessageThread } from "@/features/generation/components/creation-message-thread";
import { CreationSettingsModal } from "@/features/generation/components/creation-settings-modal";
import type { CreationComposerProps, CreationMessageThreadProps, CreationWorkspaceSettingsProps, CreationWorkspaceSidebarProps } from "@/features/generation/components/creation-workspace-types";

type CreationWorkspaceProps = {
    sidebar: CreationWorkspaceSidebarProps;
    thread: CreationMessageThreadProps;
    composer: CreationComposerProps;
    settings: CreationWorkspaceSettingsProps;
};

export function CreationWorkspace({ sidebar, thread, composer, settings }: CreationWorkspaceProps) {
    const screens = Grid.useBreakpoint();
    const isMobile = !screens.lg;
    const [threadAtBottom, setThreadAtBottom] = useState(true);
    const activeConversation = sidebar.items.find((item) => item.active);
    const modeLabel = composer.skillTargetType === "video" ? "视频创作" : "图片创作";
    const ModeIcon = composer.skillTargetType === "video" ? Video : ImagePlus;
    const statusLabel = composer.queued ? "排队中" : composer.running ? "生成中" : modeLabel;

    return (
        <div className={`studio-creation studio-page flex h-full min-h-0 flex-col overflow-hidden ${styles.workspace}`}>
            <header className={`flex shrink-0 items-center justify-between gap-3 border-b border-[var(--studio-line)] ${styles.header}`}>
                <div className="flex min-w-0 items-center gap-3">
                    <Button type="text" className="!size-10 !shrink-0 !p-0 lg:!hidden" icon={<PanelLeft className="size-5" />} onClick={sidebar.onOpenMobile} aria-label="打开会话列表" aria-expanded={sidebar.mobileOpen} />
                    <span className={styles.headerIcon}>
                        <ModeIcon className="size-[18px]" strokeWidth={1.6} />
                    </span>
                    <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--studio-muted)]">
                            <span className="shrink-0" role="status">
                                {statusLabel}
                            </span>
                        </div>
                        <h1 className="m-0 truncate text-base font-semibold tracking-tight text-[var(--studio-ink)]" title={activeConversation?.title}>
                            {activeConversation?.title || "开始新的创作"}
                        </h1>
                    </div>
                </div>
                <span className="shrink-0">
                    <Button className="!h-9 !rounded-lg" icon={<Plus className="size-4" />} onClick={sidebar.onCreate} aria-label="新建对话">
                        <span className="hidden sm:inline">新建对话</span>
                    </Button>
                </span>
            </header>
            <main className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden ${styles.layout}`}>
                <aside className="hidden min-h-0 overflow-hidden lg:block" aria-label={sidebar.heading}>
                    <div className={`h-full overflow-hidden border border-[var(--studio-line)] ${styles.conversationPanel}`}>
                        <CreationConversationSidebar
                            heading={sidebar.heading}
                            items={sidebar.items}
                            managementMode={sidebar.managementMode}
                            hasSelection={sidebar.hasSelection}
                            onCreate={sidebar.onCreate}
                            onToggleManagement={sidebar.onToggleManagement}
                            onToggleSelectAll={sidebar.onToggleSelectAll}
                            onDeleteSelected={sidebar.onDeleteSelected}
                            onSelectConversation={sidebar.onSelectConversation}
                            onToggleConversation={sidebar.onToggleConversation}
                            onRenameConversation={sidebar.onRenameConversation}
                            onDeleteConversation={sidebar.onDeleteConversation}
                        />
                    </div>
                </aside>

                <section className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden border border-[var(--studio-line)] ${styles.stage}`} aria-label="创作内容">
                    <CreationMessageThread {...thread} onAtBottomChange={setThreadAtBottom} />
                    <CreationComposer {...composer} compact={!threadAtBottom} />
                </section>
            </main>

            <CreationSettingsModal open={settings.open} title={settings.title} onClose={settings.onClose}>
                {settings.content}
            </CreationSettingsModal>

            {isMobile ? (
                <>
                    <Drawer title={sidebar.heading} placement="left" open={sidebar.mobileOpen} onClose={sidebar.onCloseMobile} styles={{ body: { padding: 16 } }}>
                        <CreationConversationSidebar
                            heading={sidebar.heading}
                            items={sidebar.items}
                            managementMode={sidebar.managementMode}
                            hasSelection={sidebar.hasSelection}
                            onCreate={() => {
                                sidebar.onCreate();
                                sidebar.onCloseMobile();
                            }}
                            onToggleManagement={sidebar.onToggleManagement}
                            onToggleSelectAll={sidebar.onToggleSelectAll}
                            onDeleteSelected={sidebar.onDeleteSelected}
                            onSelectConversation={(id) => {
                                sidebar.onSelectConversation(id);
                                sidebar.onCloseMobile();
                            }}
                            onToggleConversation={sidebar.onToggleConversation}
                            onRenameConversation={sidebar.onRenameConversation}
                            onDeleteConversation={sidebar.onDeleteConversation}
                            compact
                        />
                    </Drawer>
                </>
            ) : null}
        </div>
    );
}
