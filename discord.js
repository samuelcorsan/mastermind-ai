import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function upsertDiscordUser(user) {
  const { id, username, displayAvatarURL } = user;

  const { error: upsertUserError } = await supabase
    .from("discord_users")
    .upsert(
      { id, username, displayAvatarURL, is_paid: false },
      { onConflict: "id" }
    );
  if (upsertUserError) throw upsertUserError;

  const { error: upsertCreditError } = await supabase
    .from("user_credits")
    .upsert({ user_id: id, credits_remaining: 5 }, { onConflict: "user_id" });
  if (upsertCreditError) throw upsertCreditError;
}

export async function consumeCreditIfNeeded(user) {
  const userId = typeof user === "string" ? user : user.id;

  const { data: usr, error: fetchUserError } = await supabase
    .from("discord_users")
    .select("is_paid")
    .eq("id", userId)
    .maybeSingle();

  if (fetchUserError) {
    console.error("Error fetching user:", fetchUserError);
    throw fetchUserError;
  }

  if (!usr) {
    await upsertDiscordUser(user);
  }

  if (usr?.is_paid) return true;

  const { data: cred, error: fetchCredError } = await supabase
    .from("user_credits")
    .select("credits_remaining")
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchCredError) {
    console.error("Error fetching credits:", fetchCredError);
    throw fetchCredError;
  }

  let credits = cred?.credits_remaining ?? 5;

  if (credits <= 0) {
    return false;
  }

  const { error: updateError } = await supabase
    .from("user_credits")
    .update({
      credits_remaining: credits - 1,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) {
    console.error("Error updating credits:", updateError);
    throw updateError;
  }

  return true;
}
