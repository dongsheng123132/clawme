# kotlinx.serialization keeps the ShadowCore wire contract intact under shrinking.
-keepclassmembers class net.clawme.shadow.protocol.** {
    *** Companion;
}
-keepclasseswithmembers class net.clawme.shadow.protocol.** {
    kotlinx.serialization.KSerializer serializer(...);
}
