export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'GEMINI_API_KEY not set' } });
  }

  try {
    const { messages, system, max_tokens } = req.body;

    // Convert Claude message format to Gemini format
    const contents = messages.map(msg => {
      if (typeof msg.content === 'string') {
        return { role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] };
      }
      // Handle array content (PDF/image)
      const parts = msg.content.map(c => {
        if (c.type === 'text') return { text: c.text };
        if (c.type === 'document') return {
          inlineData: { mimeType: c.source.media_type, data: c.source.data }
        };
        if (c.type === 'image') return {
          inlineData: { mimeType: c.source.media_type, data: c.source.data }
        };
        return { text: '' };
      });
      return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
    });

    // Add system prompt as first user message if present
    if (system) {
      contents.unshift({
        role: 'user',
        parts: [{ text: `System instructions: ${system}` }]
      });
      contents.splice(1, 0, {
        role: 'model',
        parts: [{ text: 'Understood. I will follow these instructions.' }]
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            maxOutputTokens: max_tokens || 2000,
            temperature: 0.7,
          }
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: { message: data.error?.message || 'Gemini API error' }
      });
    }

    // Convert Gemini response back to Claude format
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
}
