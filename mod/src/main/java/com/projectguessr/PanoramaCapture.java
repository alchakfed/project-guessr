package com.projectguessr;

import com.projectguessr.mixin.GameRendererAccessor;
import net.minecraft.client.MinecraftClient;
import net.minecraft.text.Text;
import net.minecraft.util.math.Vec3d;

import java.io.File;
import java.nio.file.Path;

/**
 * Triggers Minecraft's built-in cubemap panorama capture into a per-shot folder
 * and records the player's coordinate via {@link CaptureLog}.
 *
 * Output layout (under the .minecraft run directory):
 *   screenshots/projectguessr/captures.jsonl        <- coordinate log (append)
 *   screenshots/projectguessr/pano_000000/panorama_0.png .. panorama_5.png
 *   screenshots/projectguessr/pano_000001/...
 *
 * The 6 files are the vanilla panorama faces, which Pannellum reads directly in
 * cubemap mode.
 */
public final class PanoramaCapture {

    private PanoramaCapture() {}

    /** Session shot counter, shown in the HUD. Resets each game launch. */
    public static int sessionCount = 0;

    /** Base folder for all ProjectGuessr output, under the run directory. */
    public static Path baseDir(MinecraftClient client) {
        return client.runDirectory.toPath()
                .resolve("screenshots").resolve("projectguessr");
    }

    /**
     * Capture one panorama at the player's current position.
     *
     * @param silent when true, suppress the chat confirmation (used by
     *               auto-capture so it doesn't spam the chat every 5 blocks).
     * @return the capture id, or null if capture could not run.
     */
    public static String capture(MinecraftClient client, boolean silent) {
        if (client.player == null || client.world == null) {
            if (!silent) {
                client.inGameHud.getChatHud().addMessage(
                        Text.translatable("projectguessr.msg.no_world"));
            }
            return null;
        }

        Config cfg = Config.get();
        String id = cfg.nextCaptureId();
        Path base = baseDir(client);
        File shotDir = base.resolve(id).toFile();
        //noinspection ResultOfMethodCallIgnored
        shotDir.mkdirs();

        Vec3d pos = client.player.getEntityPos();
        float yaw = client.player.getYaw();
        float pitch = client.player.getPitch();
        String dimension = client.world.getRegistryKey().getValue().toString();
        String world = CaptureLog.currentWorldName(client);

        try {
            // Call the vanilla cubemap routine. It renders 6 faces and writes
            // panorama_0.png .. panorama_5.png into shotDir.
            //
            // In 1.21.11 this method lives on MinecraftClient and takes only the
            // output directory (resolution is fixed internally by vanilla), so
            // cfg.panoramaResolution no longer feeds into it here.
            //
            // FALLBACK: if the 1.21.11 mapping name/signature differs and you
            // can't make GameRendererAccessor match, the vanilla body is short
            // (loop 6 orientations, ScreenshotRecorder.saveScreenshot each face
            // as panorama_<i>.png). Replace this one call with that loop.
            ((GameRendererAccessor) (Object) client)
                    .callTakePanorama(shotDir);
        } catch (Throwable t) {
            ProjectGuessrClient.LOGGER.error("Panorama capture failed", t);
            if (!silent) {
                client.inGameHud.getChatHud().addMessage(
                        Text.translatable("projectguessr.msg.error", t.getMessage()));
            }
            return null;
        }

        CaptureLog.append(base, new CaptureLog.Entry(
                id, pos.x, pos.y, pos.z, yaw, pitch, dimension, world, id));

        sessionCount++;

        if (!silent) {
            client.inGameHud.getChatHud().addMessage(Text.translatable(
                    "projectguessr.msg.captured", id,
                    (int) pos.x, (int) pos.y, (int) pos.z));
        }
        return id;
    }
}
