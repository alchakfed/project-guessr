package com.projectguessr;

import net.minecraft.client.MinecraftClient;
import net.minecraft.text.Text;
import net.minecraft.util.math.Vec3d;

/**
 * When enabled, fires a panorama capture every time the player has moved at
 * least {@code Config.autoIntervalBlocks} blocks (horizontal distance) from the
 * last captured position.
 *
 * Ticked from the client tick event in {@link ProjectGuessrClient}.
 */
public final class AutoCapture {

    private static boolean enabled = false;
    private static Vec3d lastPos = null;

    private AutoCapture() {}

    public static boolean isEnabled() {
        return enabled;
    }

    public static void toggle(MinecraftClient client) {
        enabled = !enabled;
        if (enabled) {
            // Anchor at the current position so the first auto-shot happens
            // after moving a full interval, not immediately.
            lastPos = client.player != null ? client.player.getEntityPos() : null;
            double interval = Config.get().autoIntervalBlocks;
            client.inGameHud.getChatHud().addMessage(
                    Text.translatable("projectguessr.msg.auto_on", interval));
        } else {
            lastPos = null;
            client.inGameHud.getChatHud().addMessage(
                    Text.translatable("projectguessr.msg.auto_off"));
        }
    }

    public static void tick(MinecraftClient client) {
        if (!enabled || client.player == null || client.world == null) {
            return;
        }
        Vec3d pos = client.player.getEntityPos();
        if (lastPos == null) {
            lastPos = pos;
            return;
        }
        double interval = Config.get().autoIntervalBlocks;
        double dx = pos.x - lastPos.x;
        double dz = pos.z - lastPos.z;
        double horizontalSq = dx * dx + dz * dz;
        if (horizontalSq >= interval * interval) {
            // Capture silently to avoid chat spam; HUD counter reflects it.
            PanoramaCapture.capture(client, true);
            lastPos = pos;
        }
    }
}
