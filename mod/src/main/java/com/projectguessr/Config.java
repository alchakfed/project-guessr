package com.projectguessr;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Persisted settings + per-world capture counter.
 * Stored at config/projectguessr.json.
 *
 * Note: the counter is global (not per-world) for simplicity; capture ids stay
 * unique across worlds, and the JSONL log records the world name per entry so
 * the data tools can split by world if needed.
 */
public class Config {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path PATH =
            FabricLoader.getInstance().getConfigDir().resolve("projectguessr.json");

    /** Auto-capture triggers once the player moves this many blocks (horizontal). */
    public double autoIntervalBlocks = 5.0;
    /** Edge length in pixels of each of the 6 cube faces. */
    public int panoramaResolution = 1024;
    /** Running counter used to name capture folders (pano_000000, ...). */
    public int captureCounter = 0;

    private static Config instance;

    public static Config get() {
        if (instance == null) {
            instance = load();
        }
        return instance;
    }

    private static Config load() {
        try {
            if (Files.exists(PATH)) {
                String json = Files.readString(PATH);
                Config cfg = GSON.fromJson(json, Config.class);
                if (cfg != null) {
                    return cfg;
                }
            }
        } catch (IOException | RuntimeException e) {
            ProjectGuessrClient.LOGGER.warn("Failed to read config, using defaults", e);
        }
        Config cfg = new Config();
        cfg.save();
        return cfg;
    }

    public void save() {
        try {
            Files.createDirectories(PATH.getParent());
            Files.writeString(PATH, GSON.toJson(this));
        } catch (IOException e) {
            ProjectGuessrClient.LOGGER.error("Failed to save config", e);
        }
    }

    /** Returns the next id and persists the incremented counter. */
    public synchronized String nextCaptureId() {
        String id = String.format("pano_%06d", captureCounter);
        captureCounter++;
        save();
        return id;
    }
}
