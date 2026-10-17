"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, Tabs } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Mail, LockKeyhole, UserRound, KeyRound, Send, LogIn, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";

import { getRegistrationEmailPolicy, loginByEmail, registerByEmail, sendEmailCode, ServerResponseError } from "@/services/api/server";
import { readEmailCodeCooldownSeconds, startEmailCodeCooldown } from "@/features/auth/lib/email-code-cooldown";
import { registrationEmailError } from "@/features/auth/lib/registration-email";
import { useUserStore } from "@/features/auth/stores/use-user-store";
import { IconLabel } from "@/shared/components/icon-label";
import { OAuth2LoginOptions } from "@/features/auth/components/oauth2-login-options";

type LoginForm = {
    email: string;
    password: string;
};

type RegisterForm = {
    email: string;
    code: string;
    password: string;
    nickname?: string;
};

const EMAIL_CODE_COOLDOWN_SECONDS = 60;

type AuthFormProps = {
    /** 登录或注册成功后的回调 */
    onSuccess?: () => void;
    /** OAuth2登录成功后的站内跳转目标 */
    redirectPath?: string;
    /** 邀请链接携带的邀请码 */
    invitationCode?: string;
};

export function AuthForm({ onSuccess, redirectPath, invitationCode }: AuthFormProps) {
    const { message } = App.useApp();
    const router = useRouter();
    const [activeKey, setActiveKey] = useState(invitationCode ? "register" : "login");
    const [sendingCode, setSendingCode] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [codeCooldownSeconds, setCodeCooldownSeconds] = useState(0);
    const [loginForm] = Form.useForm<LoginForm>();
    const [registerForm] = Form.useForm<RegisterForm>();
    const sendingCodeRef = useRef(false);
    const registrationEmail = (Form.useWatch("email", registerForm) || "").trim().toLowerCase();
    const setSession = useUserStore((state) => state.setSession);
    const closeAuthModal = useUserStore((state) => state.closeAuthModal);
    const emailPolicy = useQuery({
        queryKey: ["registration-email-policy"],
        queryFn: getRegistrationEmailPolicy,
        enabled: activeKey === "register",
        staleTime: 0,
        retry: 1,
    });
    const registrationClosed = emailPolicy.data?.enabled && emailPolicy.data.allowedDomains.length === 0;
    const registrationUnavailable = emailPolicy.isPending || emailPolicy.isError || registrationClosed;

    useEffect(() => {
        const updateCountdown = () => {
            const remainingSeconds = readEmailCodeCooldownSeconds(registrationEmail);
            setCodeCooldownSeconds(remainingSeconds);
        };
        updateCountdown();
        const timer = window.setInterval(updateCountdown, 1000);
        return () => window.clearInterval(timer);
    }, [registrationEmail]);

    const codeButtonText = useMemo(() => {
        if (sendingCode) return "发送中...";
        if (codeCooldownSeconds >= 60) return `${Math.ceil(codeCooldownSeconds / 60)} 分钟后重发`;
        if (codeCooldownSeconds > 0) return `${codeCooldownSeconds}s 后重发`;
        return "发送验证码";
    }, [codeCooldownSeconds, sendingCode]);

    const sendCode = async () => {
        if (sendingCodeRef.current) return;
        sendingCodeRef.current = true;
        let email = "";
        try {
            try { await registerForm.validateFields(["email"]); } catch { return; }
            email = registerForm.getFieldValue("email").trim().toLowerCase();
            const remaining = readEmailCodeCooldownSeconds(email);
            if (remaining > 0) {
                setCodeCooldownSeconds(remaining);
                return;
            }
            setSendingCode(true);
            await sendEmailCode(email);
            startEmailCodeCooldown(email, EMAIL_CODE_COOLDOWN_SECONDS);
            setCodeCooldownSeconds(EMAIL_CODE_COOLDOWN_SECONDS);
            message.success("验证码已发送，请查看邮箱");
        } catch (error) {
            if (email && error instanceof ServerResponseError && error.status === 429 && error.retryAfterSeconds) {
                startEmailCodeCooldown(email, error.retryAfterSeconds);
                setCodeCooldownSeconds(error.retryAfterSeconds);
            }
            message.error(error instanceof Error ? error.message : "发送验证码失败");
        } finally {
            sendingCodeRef.current = false;
            setSendingCode(false);
        }
    };

    const login = async (values: LoginForm) => {
        setSubmitting(true);
        try {
            const result = await loginByEmail(values);
            setSession(result);
            message.success("登录成功");
            onSuccess?.();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            setSubmitting(false);
        }
    };

    const register = async (values: RegisterForm) => {
        setSubmitting(true);
        try {
            const result = await registerByEmail({ ...values, invitationCode });
            setSession(result);
            message.success("注册成功");
            onSuccess?.();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注册失败");
        } finally {
            setSubmitting(false);
        }
    };

    const goToForgotPassword = () => {
        closeAuthModal();
        router.push("/auth/forgotPassword");
    };

    return (
        <>
            <Tabs
                activeKey={activeKey}
                onChange={setActiveKey}
                items={[
                {
                    key: "login",
                    label: <IconLabel icon={<LogIn />}>登录</IconLabel>,
                    children: (
                        <Form form={loginForm} layout="vertical" requiredMark={false} onFinish={login} className="pt-2">
                            <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "请输入邮箱" }, { type: "email", message: "邮箱格式不正确" }]}>
                                <Input prefix={<Mail className="size-4 text-[var(--studio-muted)]" aria-hidden="true" />} size="large" autoComplete="email" placeholder="name@example.com" />
                            </Form.Item>
                            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                                <Input.Password prefix={<LockKeyhole className="size-4 text-[var(--studio-muted)]" aria-hidden="true" />} size="large" autoComplete="current-password" placeholder="请输入密码" />
                            </Form.Item>
                            <div className="-mt-2 mb-2 flex justify-end">
                                <Button type="link" className="min-h-11 px-0" onClick={goToForgotPassword}>
                                    忘记密码
                                </Button>
                            </div>
                            <Button type="primary" htmlType="submit" size="large" block loading={submitting} icon={<ArrowRight className="size-4" />} iconPlacement="end">
                                登录
                            </Button>
                            <OAuth2LoginOptions redirectPath={redirectPath} invitationCode={invitationCode} />
                        </Form>
                    ),
                },
                {
                    key: "register",
                    label: <IconLabel icon={<UserPlus />}>注册</IconLabel>,
                    children: (
                        <Form form={registerForm} layout="vertical" requiredMark={false} onFinish={register} className="pt-2">
                            {emailPolicy.isError && <Alert className="mb-4" type="error" showIcon title="注册设置加载失败" action={<Button size="small" onClick={() => void emailPolicy.refetch()}>重试</Button>} />}
                            {registrationClosed && <Alert className="mb-4" type="info" showIcon title="暂未开放邮箱注册，请联系管理员" />}
                            <Form.Item name="email" label="邮箱"
                                extra={emailPolicy.data?.enabled && emailPolicy.data.allowedDomains.length > 0
                                    ? <div className="max-h-20 overflow-y-auto break-words text-xs">可注册邮箱：{emailPolicy.data.allowedDomains.map(domain => "@" + domain).join("、")}</div> : undefined}
                                rules={[{ required: true, message: "请输入邮箱" }, {
                                    validator: (_, value: string) => {
                                        if (!value) return Promise.resolve();
                                        if (!emailPolicy.data || emailPolicy.isError) return Promise.reject(new Error("注册设置尚未加载，请稍后重试"));
                                        const error = registrationEmailError(value, emailPolicy.data);
                                        return error ? Promise.reject(new Error(error)) : Promise.resolve();
                                    },
                                }]}>
                                <Input prefix={<Mail className="size-4 text-[var(--studio-muted)]" aria-hidden="true" />} size="large" autoComplete="email" placeholder="name@example.com" />
                            </Form.Item>
                            <Form.Item label="验证码" required>
                                <div className="grid grid-cols-[1fr_auto] gap-2">
                                    <Form.Item name="code" noStyle rules={[{ required: true, message: "请输入验证码" }]}>
                                        <Input prefix={<KeyRound className="size-4 text-[var(--studio-muted)]" aria-hidden="true" />} size="large" autoComplete="one-time-code" placeholder="6 位验证码" />
                                    </Form.Item>
                                    <Button size="large" icon={<Send className="size-4" />} loading={sendingCode} disabled={!!registrationUnavailable || codeCooldownSeconds > 0} onClick={sendCode}>
                                        {codeButtonText}
                                    </Button>
                                </div>
                            </Form.Item>
                            <Form.Item name="nickname" label="昵称">
                                <Input prefix={<UserRound className="size-4 text-[var(--studio-muted)]" aria-hidden="true" />} size="large" autoComplete="nickname" placeholder="可选" />
                            </Form.Item>
                            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }, { min: 8, message: "密码至少 8 位" }]}>
                                <Input.Password prefix={<LockKeyhole className="size-4 text-[var(--studio-muted)]" aria-hidden="true" />} size="large" autoComplete="new-password" placeholder="至少 8 位" />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" size="large" block loading={submitting} disabled={!!registrationUnavailable} icon={<ArrowRight className="size-4" />} iconPlacement="end">
                                注册并登录
                            </Button>
                            <OAuth2LoginOptions redirectPath={redirectPath} invitationCode={invitationCode} />
                        </Form>
                    ),
                },
                ]}
            />
        </>
    );
}

