import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Source {
  name: string;
  type: 'pdf' | 'text';
  content: string;
}

export async function generateChatResponse(
  subject: string,
  sources: Source[],
  history: ChatMessage[],
  userInput: string
) {
  const model = "gemini-3-flash-preview";
  
  const sourcesContext = sources.length > 0 
    ? sources.map(s => `SOURCE: ${s.name}\nCONTENT: ${s.content}`).join('\n\n---\n\n')
    : "No study materials provided.";

  const systemInstruction = `You are a friendly and helpful AI Tutor for Class 10 students. 
Your subject focus is: ${subject}.

CORE RULES:
1. Use the provided study materials (SOURCES) as your primary reference.
2. If the answer is not in the sources, but is part of the standard Class 10 syllabus for ${subject}, you may provide it but prioritize source material.
3. Keep responses simple, point-wise, and easy to understand for a 15-year old.
4. Be complete and do not skip important concepts.
5. Use markdown for better formatting (bold, lists, etc.).
6. If the user asks something completely irrelevant to ${subject} or their study material, gently guide them back to the topic.

STUDY MATERIALS:
${sourcesContext}
`;

  const chat = ai.chats.create({
    model: model,
    config: {
      systemInstruction: systemInstruction,
    },
    // We pass the history here. Note: GenAI SDK expects parts: [{ text: ... }]
    history: history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }))
  });

  const response = await chat.sendMessage({
    message: userInput
  });

  return response.text;
}
