"use client";

import { useState } from "react";
import { Button, Modal } from "antd";
import { MessageCircle } from "lucide-react";

export function ContactMe() {
    const [open, setOpen] = useState(false);

    return (
        <section className="mt-10 flex flex-col items-center border-t border-[var(--studio-line)] pt-8 text-center" aria-labelledby="edition-contact-title">
            <h2 id="edition-contact-title" className="text-xl font-semibold text-[var(--studio-ink)]">
                还有其他问题？
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--studio-muted)]">部署与使用问题，请联系当前站点的管理员。</p>
            <Button className="mt-5" type="primary" size="large" icon={<MessageCircle className="size-4" />} onClick={() => setOpen(true)}>
                联系我
            </Button>

            <Modal open={open} onCancel={() => setOpen(false)} footer={null} centered width={360} title="联系我">
                <div className="flex flex-col items-center gap-3 py-2">
                    <MessageCircle className="size-12 text-[var(--studio-muted)]" aria-hidden="true" />
                    <p className="text-sm text-[var(--studio-muted)]">当前站点暂未配置公开联系方式。</p>
                </div>
            </Modal>
        </section>
    );
}
