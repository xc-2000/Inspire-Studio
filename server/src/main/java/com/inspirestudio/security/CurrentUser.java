package com.inspirestudio.security;

/**
 * @title        CurrentUser.java
 * @description  当前登录用户
 * @createTime   2026-06-24 11:08:00
 */
public record CurrentUser(Long id, String email, String role, Integer status) {
}
