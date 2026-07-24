package com.projectguessr;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Client entrypoint: registers the two keybinds, the per-tick auto-capture
 * check, and the HUD indicator.
 */
public class ProjectGuessrClient implements ClientModInitializer {

    public static final String MOD_ID = "projectguessr";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static KeyBinding captureKey;
    private static KeyBinding toggleAutoKey;

    // 1.21.9+ requires a KeyBinding.Category object instead of a translation-key
    // string. The label resolves to "key.categories.projectguessr.main" in lang.
    private static final KeyBinding.Category CATEGORY =
            KeyBinding.Category.create(Identifier.of(MOD_ID, "main"));

    @Override
    public void onInitializeClient() {
        // Load config (creates defaults on first run).
        Config.get();

        captureKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.projectguessr.capture",
                InputUtil.Type.KEYSYM,
                GLFW.GLFW_KEY_F4,
                CATEGORY));

        toggleAutoKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.projectguessr.toggle_auto",
                InputUtil.Type.KEYSYM,
                GLFW.GLFW_KEY_G,
                CATEGORY));

        ClientTickEvents.END_CLIENT_TICK.register(this::onEndTick);
        HudRenderCallback.EVENT.register(this::onHudRender);

        LOGGER.info("ProjectGuessr initialized. Capture=F4, ToggleAuto=G (rebindable in Controls).");
    }

    private void onEndTick(MinecraftClient client) {
        // Drain the key queues (handles multiple presses within a tick).
        while (captureKey.wasPressed()) {
            PanoramaCapture.capture(client, false);
        }
        while (toggleAutoKey.wasPressed()) {
            AutoCapture.toggle(client);
        }
        AutoCapture.tick(client);
    }

    // 1.21.x signature: onHudRender(DrawContext, RenderTickCounter).
    private void onHudRender(net.minecraft.client.gui.DrawContext ctx,
                             net.minecraft.client.render.RenderTickCounter tick) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.options.hudHidden) {
            return;
        }
        String key = AutoCapture.isEnabled()
                ? "projectguessr.hud.auto_on"
                : "projectguessr.hud.auto_off";
        Text text = Text.translatable(key, PanoramaCapture.sessionCount);
        int color = AutoCapture.isEnabled() ? 0xFF55FF55 : 0xFFAAAAAA;
        ctx.drawTextWithShadow(client.textRenderer, text, 4, 4, color);
    }
}
