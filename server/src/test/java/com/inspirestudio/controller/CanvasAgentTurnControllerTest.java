package com.inspirestudio.controller;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.inspirestudio.agent.CanvasAgentTurnService;
import com.inspirestudio.agent.CanvasAgentTurnService.*;
import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

class CanvasAgentTurnControllerTest {
    @Test void requiresAuthenticatedUserBeforeInvokingTurn() {
        CurrentUserProvider users = new CurrentUserProvider();
        CanvasAgentTurnService turns = mock(CanvasAgentTurnService.class);
        CanvasAgentTurnController controller = new CanvasAgentTurnController(users, turns);
        StepVerifier.create(controller.turn(null)).expectError(BusinessException.class).verify();
        verifyNoInteractions(turns);
    }

    @Test void exposesTurnRouteWithUsageAndSafeCompatibilityErrors() {
        CurrentUserProvider users = mock(CurrentUserProvider.class);
        CanvasAgentTurnService turns = mock(CanvasAgentTurnService.class);
        when(users.currentUserId()).thenReturn(Mono.just(17L));
        when(turns.turn(eq(17L), any())).thenReturn(Mono.just(new TurnResponse("done", null, List.of(), "native", "model", 123, 45, 7)));
        WebTestClient client = WebTestClient.bindToController(new CanvasAgentTurnController(users, turns)).build();
        client.post().uri("/api/v1/ai/canvas-agent/turn").bodyValue("{\"toolMode\":\"native\",\"messages\":[],\"tools\":[]}")
                .header("Content-Type", "application/json").exchange().expectStatus().isOk()
                .expectBody().jsonPath("$.data.inputTokens").isEqualTo(123).jsonPath("$.data.tokenCredits").isEqualTo(7);
        when(turns.turn(eq(17L), any())).thenReturn(Mono.error(new TurnException(400, "unsupported_parameter", "tools not supported")));
        client.post().uri("/api/v1/ai/canvas-agent/turn").bodyValue("{\"toolMode\":\"native\",\"messages\":[],\"tools\":[]}")
                .header("Content-Type", "application/json").exchange().expectStatus().isBadRequest()
                .expectBody().jsonPath("$.error.status").isEqualTo(400).jsonPath("$.error.code").isEqualTo("unsupported_parameter");
    }
}
