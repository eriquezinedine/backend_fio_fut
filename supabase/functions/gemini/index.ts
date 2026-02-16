import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { GoogleGenAI, Type } from "npm:@google/genai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(error: string, status = 400) {
  return jsonResponse({ success: false, error }, status);
}

// ── Extract user ID from JWT (server-side validation) ───────────

async function getUserIdFromAuth(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    console.error("zineKey - NO_AUTH_HEADER:", authHeader ? "invalid format" : "missing");
    return null;
  }
  try {
    const token = authHeader.split(" ")[1];
    console.log("zineKey - TOKEN_RECEIVED: length =", token.length);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) {
      console.error("zineKey - GET_USER_ERROR:", error.message);
      return null;
    }
    if (!user) {
      console.error("zineKey - NO_USER_RETURNED");
      return null;
    }
    return user.id;
  } catch (e) {
    console.error("zineKey - AUTH_EXCEPTION:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Download image to base64 ────────────────────────────────────

async function downloadImageToBase64(imageUrl: string): Promise<{ base64: string; contentType: string }> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error("Failed to download image from URL");
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return {
    base64: btoa(binary),
    contentType: res.headers.get("content-type") || "image/jpeg",
  };
}

// ── Function calling tool declaration ───────────────────────────

const registerFoodTool = {
  name: "register_food",
  description: "Registra una comida identificada en la imagen con sus ingredientes y valores nutricionales",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: "Nombre del plato en español. Ej: 'Arroz con pollo y ensalada'",
      },
      description: {
        type: Type.STRING,
        description: "Descripción breve del plato (1-2 oraciones)",
      },
      type_food: {
        type: Type.STRING,
        enum: ["breakfast", "lunch", "dinner", "snack"],
        description: "Tipo de comida inferido de la imagen",
      },
      ingredients: {
        type: Type.ARRAY,
        description: "Lista de ingredientes identificados en la imagen",
        items: {
          type: Type.OBJECT,
          properties: {
            slug: {
              type: Type.STRING,
              description: "Slug del ingrediente: lowercase, sin acentos, separado por guiones",
            },
            is_new: {
              type: Type.BOOLEAN,
              description: "true si el ingrediente NO existe en la lista de la DB",
            },
            quantity: {
              type: Type.NUMBER,
              description: "Cantidad estimada en la porción visible, en la unidad del ingrediente",
            },
            name: {
              type: Type.STRING,
              description: "Nombre del ingrediente en español",
            },
            calories: {
              type: Type.NUMBER,
              description: "Calorías por base_quantity",
            },
            fat: {
              type: Type.NUMBER,
              description: "Grasa en gramos por base_quantity",
            },
            carbohydrates: {
              type: Type.NUMBER,
              description: "Carbohidratos en gramos por base_quantity",
            },
            protein: {
              type: Type.NUMBER,
              description: "Proteína en gramos por base_quantity",
            },
            unit: {
              type: Type.STRING,
              enum: ["grams", "milliliters", "units"],
              description: "Unidad de medida",
            },
            base_quantity: {
              type: Type.NUMBER,
              description: "Cantidad base para valores nutricionales (normalmente 100)",
            },
            category: {
              type: Type.STRING,
              enum: [
                "vegetables", "meat", "dairy", "fruits", "fish_seafood",
                "grains_cereals", "legumes", "nuts_seeds", "oils_fats",
                "spices_herbs", "eggs", "beverages", "sauces_condiments",
                "sweets_sugars", "processed",
              ],
              description: "Categoría del ingrediente",
            },
          },
          required: ["slug", "is_new", "quantity", "name", "calories", "fat", "carbohydrates", "protein", "unit", "base_quantity", "category"],
        },
      },
    },
    required: ["title", "description", "type_food", "ingredients"],
  },
};

// ── Gemini V1: with ingredient slug context ─────────────────────

async function callGeminiV1(
  imageUrl: string,
  ingredientContext: string,
): Promise<{ title: string; description: string; type_food: string; ingredients: any[] }> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");

  const ai = new GoogleGenAI({ apiKey });
  const { base64, contentType } = await downloadImageToBase64(imageUrl);

  const prompt = `Eres un nutricionista experto. Analiza la imagen de comida y usa la función register_food para registrarla.

Ingredientes disponibles en la base de datos (slug:nombre):
${ingredientContext}

REGLAS:
1. Identifica TODOS los ingredientes visibles en la imagen
2. Determina el type_food basándote en lo que ves:
   - "breakfast": desayuno (tostadas, cereales, huevos fritos, café con medialunas, etc.)
   - "lunch": almuerzo (plato principal con proteína, ensaladas completas, pastas, etc.)
   - "dinner": cena (similar a lunch pero también platos más livianos)
   - "snack": colación/merienda (frutas, barritas, yogur, frutos secos, etc.)
   Si no es claro, usa "snack" como default
3. Para cada ingrediente, busca el slug más cercano de la lista proporcionada
4. Si el ingrediente NO existe en la lista, márcalo como is_new: true e incluye TODOS los campos nutricionales estimados por 100g/100ml/1 unidad
5. Estima la cantidad de cada ingrediente en la porción visible
6. El título debe ser el nombre del plato en español
7. Llama a register_food con todos los datos`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: contentType, data: base64 } },
          { text: prompt },
        ],
      },
    ],
    config: {
      tools: [{ functionDeclarations: [registerFoodTool] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["register_food"] } },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall);
  if (!part?.functionCall) throw new Error("Gemini V1 did not return a function call");

  const args = part.functionCall.args as any;
  if (!args?.title || !args?.ingredients?.length) {
    throw new Error("Invalid function call args from Gemini V1");
  }

  return args;
}

// ── Gemini V2: lightweight call without ingredient list ─────────

async function callGeminiV2(
  imageUrl: string,
): Promise<{ title: string; description: string; type_food: string; ingredients: any[] }> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");

  const ai = new GoogleGenAI({ apiKey });
  const { base64, contentType } = await downloadImageToBase64(imageUrl);

  const prompt = `Eres un nutricionista experto. Analiza la imagen de comida y usa la función register_food para registrarla.

REGLAS:
1. Identifica TODOS los ingredientes visibles en la imagen
2. Determina el type_food basándote en lo que ves:
   - "breakfast": desayuno (tostadas, cereales, huevos fritos, café con medialunas, etc.)
   - "lunch": almuerzo (plato principal con proteína, ensaladas completas, pastas, etc.)
   - "dinner": cena (similar a lunch pero también platos más livianos)
   - "snack": colación/merienda (frutas, barritas, yogur, frutos secos, etc.)
   Si no es claro, usa "snack" como default
3. Para cada ingrediente, genera un slug: lowercase, sin acentos, palabras separadas por guiones. Ej: "pechuga-de-pollo", "arroz-blanco"
4. Incluye TODOS los campos nutricionales estimados por 100g/100ml/1 unidad para CADA ingrediente
5. Estima la cantidad de cada ingrediente en la porción visible
6. El título debe ser el nombre del plato en español
7. Llama a register_food con todos los datos`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: contentType, data: base64 } },
          { text: prompt },
        ],
      },
    ],
    config: {
      tools: [{ functionDeclarations: [registerFoodTool] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["register_food"] } },
    },
  });

  const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall);
  if (!part?.functionCall) throw new Error("Gemini V2 did not return a function call");

  const args = part.functionCall.args as any;
  if (!args?.title || !args?.ingredients?.length) {
    throw new Error("Invalid function call args from Gemini V2");
  }

  return args;
}

// ── Fuzzy matching utilities ────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 && bb.size === 0) return 0;
  let intersection = 0;
  for (const bg of ba) if (bb.has(bg)) intersection++;
  return (2 * intersection) / (ba.size + bb.size);
}

function fuzzyMatchIngredient(
  geminiSlug: string,
  geminiName: string,
  dbIngredients: any[],
): any | null {
  let bestMatch: any = null;
  let bestScore = 0;
  const threshold = 0.55;

  for (const dbIng of dbIngredients) {
    if (dbIng.slug === geminiSlug) return dbIng;

    const slugScore = similarity(geminiSlug, dbIng.slug);
    const nameScore = similarity(geminiName, dbIng.name);
    const score = Math.max(slugScore, nameScore);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = dbIng;
    }
  }

  return bestScore >= threshold ? bestMatch : null;
}

// ── Recognize food V2 (no slug list, fuzzy matching) ────────────

async function recognizeFoodV2(imageUrl: string, userId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: existingIngredients, error: ingredientError } = await supabase
    .from("ingredient")
    .select("id, name, slug, unit, category, calories, fat, carbohydrates, protein, base_quantity")
    .order("name");

  if (ingredientError) throw new Error(`DB error: ${ingredientError.message}`);
  const dbIngredients = existingIngredients ?? [];

  const geminiResult = await callGeminiV2(imageUrl);

  const ingredientIdMap = new Map<string, any>();
  const newIngredients: any[] = [];

  for (const gi of geminiResult.ingredients) {
    const match = fuzzyMatchIngredient(gi.slug, gi.name, dbIngredients);
    if (match) {
      ingredientIdMap.set(gi.slug, match);
    } else {
      newIngredients.push(gi);
    }
  }

  if (newIngredients.length > 0) {
    const toInsert = newIngredients.map((i: any) => ({
      name: i.name || i.slug.replace(/-/g, " "),
      slug: i.slug,
      calories: i.calories ?? 0,
      fat: i.fat ?? 0,
      carbohydrates: i.carbohydrates ?? 0,
      protein: i.protein ?? 0,
      unit: i.unit ?? "grams",
      base_quantity: i.base_quantity ?? 100,
      category: i.category ?? null,
    }));

    const { error: insertError } = await supabase
      .from("ingredient")
      .upsert(toInsert, { onConflict: "slug", ignoreDuplicates: true });

    if (insertError) throw new Error(`Insert ingredient error: ${insertError.message}`);

    const newSlugs = newIngredients.map((i: any) => i.slug);
    const { data: createdIngredients } = await supabase
      .from("ingredient")
      .select("id, name, slug, unit, category, calories, fat, carbohydrates, protein, base_quantity")
      .in("slug", newSlugs);

    for (const ing of createdIngredients ?? []) {
      ingredientIdMap.set(
        newIngredients.find((ni: any) => ni.slug === ing.slug)?.slug ?? ing.slug,
        ing,
      );
    }
  }

  const { data: food, error: foodError } = await supabase
    .from("food")
    .insert({
      title: geminiResult.title,
      description: geminiResult.description,
      type_food: geminiResult.type_food,
      image_url: imageUrl,
    })
    .select("id")
    .single();

  if (foodError) throw new Error(`Insert food error: ${foodError.message}`);

  const details = geminiResult.ingredients
    .filter((i: any) => ingredientIdMap.has(i.slug))
    .map((i: any) => ({
      id_food: food.id,
      id_ingredient: ingredientIdMap.get(i.slug).id,
      quantity: i.quantity ?? 0,
    }));

  let insertedDetails: any[] = [];
  if (details.length > 0) {
    const { data: detailData, error: detailError } = await supabase
      .from("detail_food_ingredient")
      .insert(details)
      .select("id, id_ingredient, quantity");

    if (detailError) throw new Error(`Insert details error: ${detailError.message}`);
    insertedDetails = detailData ?? [];
  }

  const today = new Date().toISOString().split("T")[0];
  const { data: schedule, error: scheduleError } = await supabase
    .from("food_schedule")
    .insert({
      id_food: food.id,
      id_user_profile: userId,
      id_created_by: userId,
      schedule_type: "today",
      start_date: today,
      is_completed: true,
    })
    .select("id, schedule_type, start_date, is_completed")
    .single();

  if (scheduleError) throw new Error(`Insert schedule error: ${scheduleError.message}`);

  const responseIngredients = insertedDetails.map((detail: any) => {
    const slug = geminiResult.ingredients.find(
      (i: any) => ingredientIdMap.get(i.slug)?.id === detail.id_ingredient,
    )?.slug;
    const ingData = slug ? ingredientIdMap.get(slug) : null;

    return {
      id: detail.id_ingredient,
      id_detail_food_ingredient: detail.id,
      name: ingData?.name ?? "Unknown",
      slug: ingData?.slug ?? "",
      calories: Number(ingData?.calories ?? 0),
      fat: Number(ingData?.fat ?? 0),
      carbohydrates: Number(ingData?.carbohydrates ?? 0),
      protein: Number(ingData?.protein ?? 0),
      unit: ingData?.unit ?? "grams",
      base_quantity: Number(ingData?.base_quantity ?? 100),
      category: ingData?.category ?? null,
      quantity: Number(detail.quantity),
    };
  });

  return {
    success: true,
    version: "v2",
    food: {
      id: food.id,
      title: geminiResult.title,
      description: geminiResult.description,
      type_food: geminiResult.type_food,
      image_url: imageUrl,
      ingredients: responseIngredients,
    },
    food_schedule: schedule,
  };
}

// ── Recognize food action (V1 with V2 fallback) ────────────────

async function recognizeFood(imageUrl: string, userId: string): Promise<any> {
  try {
    return await recognizeFoodV1(imageUrl, userId);
  } catch (v1Error) {
    console.warn("zineKey - V1_FAILED, falling back to V2:", v1Error instanceof Error ? v1Error.message : v1Error);
    return await recognizeFoodV2(imageUrl, userId);
  }
}

async function recognizeFoodV1(imageUrl: string, userId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: existingIngredients, error: ingredientError } = await supabase
    .from("ingredient")
    .select("id, name, slug, unit, category, calories, fat, carbohydrates, protein, base_quantity")
    .order("name");

  if (ingredientError) throw new Error(`DB error: ${ingredientError.message}`);

  const slugMap = new Map<string, any>();
  const contextParts: string[] = [];
  for (const ing of existingIngredients ?? []) {
    if (ing.slug) {
      slugMap.set(ing.slug, ing);
      contextParts.push(`${ing.slug}:${ing.name}`);
    }
  }
  const ingredientContext = contextParts.join(",");

  const geminiResult = await callGeminiV1(imageUrl, ingredientContext);

  const newIngredients = geminiResult.ingredients.filter((i: any) => i.is_new);
  const existingRefs = geminiResult.ingredients.filter((i: any) => !i.is_new);

  const ingredientIdMap = new Map<string, any>();

  if (newIngredients.length > 0) {
    const toInsert = newIngredients.map((i: any) => ({
      name: i.name || i.slug.replace(/-/g, " "),
      slug: i.slug,
      calories: i.calories ?? 0,
      fat: i.fat ?? 0,
      carbohydrates: i.carbohydrates ?? 0,
      protein: i.protein ?? 0,
      unit: i.unit ?? "grams",
      base_quantity: i.base_quantity ?? 100,
      category: i.category ?? null,
    }));

    const { error: insertError } = await supabase
      .from("ingredient")
      .upsert(toInsert, { onConflict: "slug", ignoreDuplicates: true });

    if (insertError) throw new Error(`Insert ingredient error: ${insertError.message}`);

    const newSlugs = newIngredients.map((i: any) => i.slug);
    const { data: createdIngredients } = await supabase
      .from("ingredient")
      .select("id, name, slug, unit, category, calories, fat, carbohydrates, protein, base_quantity")
      .in("slug", newSlugs);

    for (const ing of createdIngredients ?? []) {
      ingredientIdMap.set(ing.slug, ing);
    }
  }

  for (const ref of existingRefs) {
    const existing = slugMap.get(ref.slug);
    if (existing) {
      ingredientIdMap.set(ref.slug, existing);
    }
  }

  const { data: food, error: foodError } = await supabase
    .from("food")
    .insert({
      title: geminiResult.title,
      description: geminiResult.description,
      type_food: geminiResult.type_food,
      image_url: imageUrl,
    })
    .select("id")
    .single();

  if (foodError) throw new Error(`Insert food error: ${foodError.message}`);

  const details = geminiResult.ingredients
    .filter((i: any) => ingredientIdMap.has(i.slug))
    .map((i: any) => ({
      id_food: food.id,
      id_ingredient: ingredientIdMap.get(i.slug).id,
      quantity: i.quantity ?? 0,
    }));

  let insertedDetails: any[] = [];
  if (details.length > 0) {
    const { data: detailData, error: detailError } = await supabase
      .from("detail_food_ingredient")
      .insert(details)
      .select("id, id_ingredient, quantity");

    if (detailError) throw new Error(`Insert details error: ${detailError.message}`);
    insertedDetails = detailData ?? [];
  }

  const today = new Date().toISOString().split("T")[0];
  const { data: schedule, error: scheduleError } = await supabase
    .from("food_schedule")
    .insert({
      id_food: food.id,
      id_user_profile: userId,
      id_created_by: userId,
      schedule_type: "today",
      start_date: today,
      is_completed: true,
    })
    .select("id, schedule_type, start_date, is_completed")
    .single();

  if (scheduleError) throw new Error(`Insert schedule error: ${scheduleError.message}`);

  const responseIngredients = insertedDetails.map((detail: any) => {
    const slug = geminiResult.ingredients.find(
      (i: any) => ingredientIdMap.get(i.slug)?.id === detail.id_ingredient,
    )?.slug;
    const ingData = slug ? ingredientIdMap.get(slug) : null;

    return {
      id: detail.id_ingredient,
      id_detail_food_ingredient: detail.id,
      name: ingData?.name ?? "Unknown",
      slug: ingData?.slug ?? "",
      calories: Number(ingData?.calories ?? 0),
      fat: Number(ingData?.fat ?? 0),
      carbohydrates: Number(ingData?.carbohydrates ?? 0),
      protein: Number(ingData?.protein ?? 0),
      unit: ingData?.unit ?? "grams",
      base_quantity: Number(ingData?.base_quantity ?? 100),
      category: ingData?.category ?? null,
      quantity: Number(detail.quantity),
    };
  });

  return {
    success: true,
    food: {
      id: food.id,
      title: geminiResult.title,
      description: geminiResult.description,
      type_food: geminiResult.type_food,
      image_url: imageUrl,
      ingredients: responseIngredients,
    },
    food_schedule: schedule,
  };
}

// ── Main handler ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (!action) {
      return errorResponse("Missing 'action' field");
    }

    const userId = await getUserIdFromAuth(req);
    if (!userId) {
      console.error("zineKey - AUTH_FAILED: no userId from token");
      return errorResponse("Unauthorized: invalid or missing JWT", 401);
    }

    console.log("zineKey - AUTH_OK: userId =", userId);

    switch (action) {
      case "recognize-food": {
        const { image_url } = body;
        if (!image_url || typeof image_url !== "string") {
          console.error("zineKey - MISSING_IMAGE_URL");
          return errorResponse("Missing or invalid 'image_url'");
        }
        console.log("zineKey - RECOGNIZE_START: image_url =", image_url);
        const result = await recognizeFood(image_url, userId);
        console.log("zineKey - RECOGNIZE_OK: food_id =", result?.food?.id);
        return jsonResponse(result);
      }
      default:
        console.error("zineKey - UNKNOWN_ACTION:", action);
        return errorResponse(`Unknown action: ${action}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("zineKey - ERROR:", errMsg);
    return errorResponse(errMsg, 500);
  }
});
