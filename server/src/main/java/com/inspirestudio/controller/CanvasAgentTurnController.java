package com.inspirestudio.controller;

import com.inspirestudio.agent.CanvasAgentTurnService;
import com.inspirestudio.agent.CanvasAgentTurnService.TurnException;
import com.inspirestudio.common.ApiResponse;
import com.inspirestudio.security.CurrentUserProvider;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

/** Authenticated transport for the infinite-canvas API runtime; credentials remain on the server. */
@RestController
@RequestMapping("/api/v1/ai/canvas-agent")
@RequiredArgsConstructor
public class CanvasAgentTurnController {
    private final CurrentUserProvider users;
    private final CanvasAgentTurnService turns;

    @PostMapping("/turn")
    public Mono<ApiResponse<CanvasAgentTurnService.TurnResponse>> turn(@RequestBody CanvasAgentTurnService.TurnRequest request) {
        return users.currentUserId().flatMap(userId -> turns.turn(userId, request)).map(ApiResponse::ok);
    }

    @ExceptionHandler(TurnException.class)
    public ResponseEntity<Map<String, Object>> turnError(TurnException error) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("status", error.status());
        details.put("code", error.code());
        details.put("message", error.getMessage());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", error.status());
        body.put("msg", error.getMessage());
        body.put("data", null);
        body.put("error", details);
        return ResponseEntity.status(error.status() >= 400 && error.status() <= 599 ? error.status() : 502).body(body);
    }
}
