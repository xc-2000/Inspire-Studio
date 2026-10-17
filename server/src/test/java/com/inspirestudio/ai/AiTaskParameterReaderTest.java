package com.inspirestudio.ai;

import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class AiTaskParameterReaderTest {
    @Test
    void acceptsPersistedIntegerStringsWithoutLosingBounds() {
        assertEquals(30, AiTaskParameterReader.intParameter(Map.of("seconds", "30"), "seconds", 5, 1, 300));
        assertEquals(30, AiTaskParameterReader.intParameter(Map.of("seconds", " 30 "), "seconds", 5, 1, 300));
        assertEquals(300, AiTaskParameterReader.intParameter(Map.of("seconds", "999"), "seconds", 5, 1, 300));
        assertEquals(1, AiTaskParameterReader.intParameter(Map.of("seconds", "-2"), "seconds", 5, 1, 300));
    }

    @Test
    void preservesDefaultForMissingOrInvalidValues() {
        for (String invalid : new String[] {"", "auto", "30s", "3.5", "9999999999999999"}) {
            assertEquals(5, AiTaskParameterReader.intParameter(Map.of("seconds", invalid), "seconds", 5, 1, 300));
        }
        assertEquals(5, AiTaskParameterReader.intParameter(null, "seconds", 5, 1, 300));
        assertEquals(30, AiTaskParameterReader.intParameter(Map.of("seconds", 30), "seconds", 5, 1, 300));
    }
}
