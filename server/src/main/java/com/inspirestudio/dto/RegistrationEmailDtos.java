package com.inspirestudio.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

public final class RegistrationEmailDtos {
    private RegistrationEmailDtos() {}

    public record Policy(boolean enabled, List<String> allowedDomains) {}

    public record Settings(boolean enabled,
                           @NotNull @Size(max = 100) List<String> allowedDomains,
                           @Min(0) int version) {}
}

