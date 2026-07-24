package com.projectguessr.mixin;

import net.minecraft.client.MinecraftClient;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

import java.io.File;

/*
 * Exposes Minecraft's built-in cubemap panorama routine so we can call it
 * ourselves and control the output folder per shot.
 *
 * In 1.21.11 Yarn (build.6) this method lives on MinecraftClient (not
 * GameRenderer as in older versions) and its signature is:
 *
 *     Text takePanorama(File directory)   // intermediary: method_35698
 *
 * The width/height are now fixed internally by vanilla, and the method returns
 * a user-oriented status Text. It still writes panorama_0.png .. panorama_5.png
 * into the given directory.
 *
 * If `gradlew build` reports that @Invoker doesn't match anything for
 * "takePanorama", open the 1.21.11 mappings (`./gradlew yarn` launches Enigma,
 * then search "panorama") and update the @Invoker name / method signature below
 * to match. Everything else in the mod is version-agnostic.
 */
@Mixin(MinecraftClient.class)
public interface GameRendererAccessor {

    @Invoker("takePanorama")
    Text callTakePanorama(File directory);
}
