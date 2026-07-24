package com.projectguessr;

import net.minecraft.client.MinecraftClient;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Locale;

/**
 * Append-only log pairing every panorama with the world coordinate it was shot
 * at. One JSON object per line (JSONL), written next to the panorama folders at
 * screenshots/projectguessr/captures.jsonl.
 *
 * This coordinate log is the whole point of the mod: it's the answer key the
 * web game uses to score guesses. We write raw JSON by hand (no Gson dependency
 * on the hot path) to keep the format trivially stable for the Node tooling.
 */
public final class CaptureLog {

    private CaptureLog() {}

    public record Entry(
            String id,
            double x, double y, double z,
            float yaw, float pitch,
            String dimension,
            String world,
            String folder
    ) {}

    public static synchronized void append(Path baseDir, Entry e) {
        Path logFile = baseDir.resolve("captures.jsonl");
        String line = toJson(e) + System.lineSeparator();
        try {
            Files.createDirectories(baseDir);
            try (BufferedWriter w = Files.newBufferedWriter(
                    logFile, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND)) {
                w.write(line);
            }
        } catch (IOException ex) {
            ProjectGuessrClient.LOGGER.error("Failed to append capture log", ex);
        }
    }

    private static String toJson(Entry e) {
        // Locale.ROOT so decimals always use '.', never ',' — the Node tools
        // parse this with JSON.parse and a comma would corrupt it.
        return String.format(Locale.ROOT,
                "{\"id\":\"%s\",\"x\":%.2f,\"y\":%.2f,\"z\":%.2f," +
                "\"yaw\":%.2f,\"pitch\":%.2f,\"dimension\":\"%s\"," +
                "\"world\":\"%s\",\"folder\":\"%s\"}",
                esc(e.id()), e.x(), e.y(), e.z(), e.yaw(), e.pitch(),
                esc(e.dimension()), esc(e.world()), esc(e.folder()));
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /**
     * Best-effort human-readable name for the current world/server, used only as
     * a label in the log (the data tools also let you pass --world explicitly).
     */
    public static String currentWorldName(MinecraftClient client) {
        if (client.getServer() != null) {
            // Singleplayer / integrated server: use the save folder name.
            String name = client.getServer().getSaveProperties().getLevelName();
            return name != null ? name : "singleplayer";
        }
        if (client.getCurrentServerEntry() != null) {
            return client.getCurrentServerEntry().address;
        }
        return "unknown";
    }
}
