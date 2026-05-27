import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_CATEGORIES = ['Architecture', 'Concept Art', 'Texture', 'Reference', 'Photorealistic'];

const ANALYSIS_PROMPT = `You are a metadata generator for an AI image gallery. Analyze this image and return ONLY a JSON object.
Fields:
- title: short evocative title (3-6 words, Title Case)
- prompt: detailed AI image generation prompt describing what you see
- category: one of "Architecture", "Concept Art", "Texture", "Reference", "Photorealistic"
- aspect_ratio: one of "1:1", "16:9", "4:3", "9:16", "3:2"
- tags: array of 4-7 lowercase strings`;

async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status} ${url}`);
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

function getMediaType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return map[ext] || 'image/jpeg';
}

async function analyzeImage(filePath) {
  const rawUrl = `https://raw.githubusercontent.com/hjourneyk/gallery-images/main/${filePath}`;
  const base64 = await fetchImageAsBase64(rawUrl);
  const mediaType = getMediaType(filePath);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: ANALYSIS_PROMPT },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude response: ${text}`);
  return JSON.parse(jsonMatch[0]);
}

async function processImage(filePath) {
  const imageUrl = `https://github.com/hjourneyk/gallery-images/blob/main/${filePath}?raw=true`;

  const { data: existing } = await supabase
    .from('gallery_items')
    .select('id')
    .eq('image_url', imageUrl)
    .maybeSingle();

  if (existing) {
    console.log(`Skipping (already exists): ${filePath}`);
    return;
  }

  console.log(`Analyzing: ${filePath}`);
  const metadata = await analyzeImage(filePath);

  const category = VALID_CATEGORIES.includes(metadata.category) ? metadata.category : 'Concept Art';

  const { error } = await supabase.from('gallery_items').insert({
    title: metadata.title,
    prompt: metadata.prompt,
    image_url: imageUrl,
    category,
    aspect_ratio: metadata.aspect_ratio,
    tags: metadata.tags,
  });

  if (error) throw new Error(`Supabase insert failed for ${filePath}: ${error.message}`);
  console.log(`Inserted: ${filePath} → "${metadata.title}"`);
}

async function main() {
  const newImages = (process.env.NEW_IMAGES || '').trim();
  if (!newImages) {
    console.log('No new images to process.');
    return;
  }

  const files = newImages.split('\n').map(f => f.trim()).filter(Boolean);
  console.log(`Processing ${files.length} image(s)...`);

  for (const file of files) {
    try {
      await processImage(file);
    } catch (err) {
      console.error(`Error processing ${file}:`, err.message);
    }
  }
}

main();
