package com.inspirestudio.storage;

/** Image signatures take precedence over client filenames and declared MIME types. */
public final class ImageMediaTypes {
    private ImageMediaTypes() { }

    public static String detect(byte[] data) {
        if (data == null) return "";
        if (matches(data, 0, 0x89, 'P', 'N', 'G', 13, 10, 26, 10)) return "image/png";
        if (matches(data, 0, 0xff, 0xd8, 0xff)) return "image/jpeg";
        if (matches(data, 0, 'G', 'I', 'F', '8', '7', 'a') || matches(data, 0, 'G', 'I', 'F', '8', '9', 'a')) return "image/gif";
        if (matches(data, 0, 'R', 'I', 'F', 'F') && matches(data, 8, 'W', 'E', 'B', 'P')) return "image/webp";
        if (matches(data, 0, 'B', 'M')) return "image/bmp";
        return "";
    }

    public static String forMedia(String kind, byte[] data, String fallback) {
        if (!"image".equals(kind) && !"avatar".equals(kind)) return fallback;
        String detected = detect(data);
        return detected.isEmpty() ? fallback : detected;
    }

    private static boolean matches(byte[] data, int offset, int... signature) {
        if (data.length < offset + signature.length) return false;
        for (int i = 0; i < signature.length; i++) if ((data[offset + i] & 0xff) != signature[i]) return false;
        return true;
    }
}
