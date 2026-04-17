import { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  serverTimestamp, 
  doc, 
  updateDoc,
  deleteDoc,
  Timestamp
} from 'firebase/firestore';
import { 
  db, 
  auth, 
  signInWithGoogle, 
  signOut, 
  onAuthStateChanged, 
  User 
} from './lib/firebase';
import { generateChatResponse, ChatMessage, Source } from './lib/gemini';
import { extractTextFromPDF } from './lib/pdf';
import { 
  Plus, 
  LogOut, 
  MessageSquare, 
  Send, 
  FileText, 
  Upload, 
  X, 
  Download, 
  ChevronRight,
  Loader2,
  Trash2,
  BookOpen
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';

// --- Types ---

interface ChatSession {
  id: string;
  userId: string;
  subject: string;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Timestamp;
}

interface StudySource {
  id: string;
  name: string;
  type: 'pdf' | 'text';
  content: string;
  createdAt: Timestamp;
}

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sources, setSources] = useState<StudySource[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [showSubjectModal, setShowSubjectModal] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setCurrentChatId(null);
      return;
    }

    const q = query(
      collection(db, 'chats'),
      where('userId', '==', user.uid),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const chatList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as ChatSession[];
      setChats(chatList);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!currentChatId || !user) {
      setMessages([]);
      setSources([]);
      return;
    }

    // Subscribe to messages
    const mq = query(
      collection(db, `chats/${currentChatId}/messages`),
      orderBy('createdAt', 'asc')
    );
    const unsubMessages = onSnapshot(mq, (snapshot) => {
      setMessages(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Message[]);
    });

    // Subscribe to sources
    const sq = query(
      collection(db, `chats/${currentChatId}/sources`),
      orderBy('createdAt', 'desc')
    );
    const unsubSources = onSnapshot(sq, (snapshot) => {
      setSources(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as StudySource[]);
    });

    return () => {
      unsubMessages();
      unsubSources();
    };
  }, [currentChatId, user]);

  const createNewChat = async (subject: string) => {
    if (!user) return;
    try {
      const docRef = await addDoc(collection(db, 'chats'), {
        userId: user.uid,
        subject,
        title: `Study Session - ${subject}`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setCurrentChatId(docRef.id);
      setShowSubjectModal(false);
    } catch (error) {
      console.error("Error creating chat:", error);
    }
  };

  const deleteChat = async (id: string) => {
    if (window.confirm("Delete this chat?")) {
      await deleteDoc(doc(db, 'chats', id));
      if (currentChatId === id) setCurrentChatId(null);
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || !currentChatId || !user || isSending) return;

    setIsSending(true);
    try {
      const chatRef = doc(db, 'chats', currentChatId);
      const currentChat = chats.find(c => c.id === currentChatId);
      
      // Add user message
      await addDoc(collection(db, `chats/${currentChatId}/messages`), {
        role: 'user',
        content: text,
        createdAt: serverTimestamp()
      });

      // Update chat session timestamp
      await updateDoc(chatRef, { updatedAt: serverTimestamp() });

      // Generate AI response
      const geminiHistory: ChatMessage[] = messages.map(m => ({ role: m.role, content: m.content }));
      const geminiSources: Source[] = sources.map(s => ({ name: s.name, type: s.type, content: s.content }));
      
      const response = await generateChatResponse(
        currentChat?.subject || "General",
        geminiSources,
        geminiHistory,
        text
      );

      // Add assistant message
      await addDoc(collection(db, `chats/${currentChatId}/messages`), {
        role: 'assistant',
        content: response,
        createdAt: serverTimestamp()
      });

    } catch (error) {
      console.error("Error sending message:", error);
    } finally {
      setIsSending(false);
    }
  };

  const handleUploadSource = async (file: File) => {
    if (!currentChatId || isSending) return;
    setIsSending(true);
    try {
      const text = await extractTextFromPDF(file);
      await addDoc(collection(db, `chats/${currentChatId}/sources`), {
        name: file.name,
        type: 'pdf',
        content: text,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      console.error("Error uploading source:", error);
      alert("Failed to process PDF. Make sure it's valid.");
    } finally {
      setIsSending(false);
    }
  };

  const handlePasteSource = async (name: string, text: string) => {
    if (!currentChatId || !text.trim()) return;
    try {
      await addDoc(collection(db, `chats/${currentChatId}/sources`), {
        name: name || "Pasted Text",
        type: 'text',
        content: text,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      console.error("Error adding source:", error);
    }
  };

  const exportPDF = () => {
    if (!messages.length) return;
    const doc = new jsPDF();
    const currentChat = chats.find(c => c.id === currentChatId);
    
    doc.setFontSize(18);
    doc.text(`AI Tutor Study Session: ${currentChat?.subject}`, 14, 22);
    doc.setFontSize(10);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 14, 30);
    
    let y = 40;
    messages.forEach((msg) => {
      const role = msg.role === 'user' ? 'Question' : 'Answer';
      const lines = doc.splitTextToSize(`${role}: ${msg.content}`, 180);
      
      if (y + (lines.length * 7) > 280) {
        doc.addPage();
        y = 20;
      }
      
      doc.setFont("helvetica", msg.role === 'user' ? "bold" : "normal");
      doc.text(lines, 14, y);
      y += (lines.length * 7) + 5;
    });

    doc.save(`chat-${currentChatId}.pdf`);
  };

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#0d0d0d] text-white">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-[#0d0d0d] text-white p-6">
        <div className="max-w-md w-full text-center space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
          <BookOpen className="w-16 h-16 mx-auto text-blue-500" />
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">Class 10 AI Tutor</h1>
            <p className="text-gray-400">Master your syllabus with your personal smart study material assistant.</p>
          </div>
          <button 
            onClick={signInWithGoogle}
            className="w-full flex items-center justify-center gap-3 bg-white text-black font-semibold py-4 rounded-xl hover:bg-gray-200 transition-colors"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/action/button/google_plus/multiple_32.png" className="w-6 h-6" referrerPolicy="no-referrer" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-main-bg text-text-prime flex overflow-hidden font-sans">
      {/* Sidebar */}
      <aside className="w-[260px] bg-sidebar border-r border-border-dim flex flex-col shrink-0">
        <div className="p-4">
          <button 
            onClick={() => setShowSubjectModal(true)}
            className="w-full flex items-center gap-2.5 px-4 py-3 bg-transparent border border-border-dim rounded-lg hover:bg-white/5 transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
        </div>

        <div className="px-5 py-2 text-[11px] font-semibold text-text-second uppercase tracking-wider">
          Recent Study Sessions
        </div>

        <nav className="flex-1 overflow-y-auto px-2 space-y-1 custom-scrollbar">
          {chats.map(chat => (
            <div key={chat.id} className="group relative">
              <button
                onClick={() => setCurrentChatId(chat.id)}
                className={`w-full text-left px-3 py-2.5 rounded-md flex items-center gap-3 transition-colors ${
                  currentChatId === chat.id ? 'bg-surface-light text-text-prime' : 'text-text-second hover:bg-[#262626] hover:text-text-prime'
                }`}
              >
                <div className="truncate text-sm pr-6">
                  <div className="font-medium truncate">{chat.subject}</div>
                </div>
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-border-dim mt-auto">
          <div className="flex items-center gap-3 px-3 py-2 text-text-second text-[12px] opacity-60">
            Class 10 • Academic Year 2024-25
          </div>
          <div className="flex items-center gap-3 px-3 pt-3">
            <img 
              src={user.photoURL || 'https://www.gravatar.com/avatar/000?d=mp'} 
              className="w-8 h-8 rounded border border-border-dim shrink-0" 
              referrerPolicy="no-referrer" 
            />
            <div className="flex-1 truncate">
              <div className="text-sm font-medium truncate">{user.displayName}</div>
            </div>
            <button 
              onClick={signOut}
              title="Sign Out"
              className="p-1.5 text-text-second hover:text-text-prime transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative bg-main-bg overflow-hidden">
        {currentChatId ? (
          <>
            {/* Header */}
            <header className="h-[60px] px-6 flex items-center justify-between border-b border-border-dim z-10 bg-main-bg/80 backdrop-blur-md">
              <div className="flex items-center gap-4">
                <span className="bg-accent-blue/10 text-accent-blue border border-accent-blue px-3 py-1 rounded-full text-[12px] font-semibold uppercase tracking-wide">
                  {chats.find(c => c.id === currentChatId)?.subject}
                </span>
                <span className="text-[12px] text-text-second flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />
                  {sources.length > 0 ? sources[0].name : 'No source active'}
                </span>
              </div>
              <button 
                onClick={exportPDF}
                title="DLD Chat (PDF)"
                className="bg-accent-blue text-white hover:bg-accent-blue/90 px-3.5 py-1.5 rounded-md text-[12px] font-bold transition-colors"
              >
                DLD Chat (PDF)
              </button>
            </header>

            {/* Chat Body */}
            <div className="flex-1 overflow-y-auto px-6 custom-scrollbar relative">
              <div className="max-w-[800px] mx-auto py-10 space-y-8">
                {messages.length === 0 && (
                  <div className="py-20 text-center space-y-4">
                    <div className="w-16 h-16 bg-surface-light rounded-2xl flex items-center justify-center mx-auto mb-6">
                      <FileText className="w-8 h-8 text-text-second" />
                    </div>
                    <h3 className="text-xl font-bold">Start your Study Session</h3>
                    <p className="text-text-second text-sm max-w-sm mx-auto">
                      AI Tutor is focused strictly on your uploaded materials for Class 10 syllabus.
                    </p>
                  </div>
                )}
                
                {messages.map((msg, i) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={msg.id || i} 
                    className="flex gap-4"
                  >
                    <div className={`w-8 h-8 rounded text-[12px] font-bold flex items-center justify-center shrink-0 mt-1 ${
                      msg.role === 'user' ? 'bg-[#ab47bc]' : 'bg-[#10a37f]'
                    }`}>
                      {msg.role === 'user' ? (user.displayName?.[0] || 'U') : 'AI'}
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="text-[15px] leading-relaxed text-text-prime">
                        {msg.role === 'assistant' ? (
                          <div className="markdown-content bubble">
                            <ReactMarkdown>{msg.content}</ReactMarkdown>
                          </div>
                        ) : (
                          <div className="bubble">
                            <p>{msg.content}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
                {isSending && (
                   <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-4">
                      <div className="w-8 h-8 rounded bg-[#10a37f] flex items-center justify-center shrink-0">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                      <div className="text-text-second text-sm animate-pulse flex items-center">
                        AI Tutor is thinking...
                      </div>
                   </motion.div>
                )}
              </div>
            </div>

            {/* Input & Sources Area */}
            <div className="p-4 bg-gradient-to-t from-main-bg via-main-bg to-transparent px-[100px] pb-10">
              <div className="max-w-3xl mx-auto space-y-4">
                {/* Sources Bar */}
                {sources.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {sources.map(source => (
                      <div key={source.id} className="flex items-center gap-2 px-2.5 py-1.5 bg-surface-light border border-border-dim rounded-md text-[11px] font-medium text-text-second">
                        <FileText className="w-3.5 h-3.5 text-accent-blue" />
                        <span className="max-w-[120px] truncate">{source.name}</span>
                        <button className="hover:text-red-500" onClick={() => deleteDoc(doc(db, `chats/${currentChatId}/sources`, source.id))}>
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Main Input Controls */}
                <div className="bg-surface-light border border-border-dim rounded-xl p-3 flex items-center gap-3">
                  <label className="p-2 bg-main-bg border border-border-dim rounded hover:bg-main-bg/80 transition-colors cursor-pointer" title="Upload PDF">
                    <Upload className="w-4 h-4 text-text-second" />
                    <input 
                      type="file" 
                      accept=".pdf" 
                      className="hidden" 
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleUploadSource(file);
                        e.target.value = '';
                      }} 
                    />
                  </label>
                  <ChatInput onSend={handleSendMessage} disabled={isSending} />
                </div>
                
                <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--color-text-second)', marginTop: '12px' }}>
                    AI Tutor is focused strictly on your uploaded materials for Class 10 syllabus.
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-500/5 via-transparent to-transparent">
            <div className="max-w-lg w-full text-center space-y-12">
              <div className="relative inline-block">
                <div className="absolute -inset-4 bg-blue-500/20 blur-3xl rounded-full"></div>
                <BookOpen className="w-20 h-20 text-blue-500 relative" />
              </div>
              <div className="space-y-4">
                <h2 className="text-4xl font-bold tracking-tight">Welcome back!</h2>
                <p className="text-gray-400 text-lg leading-relaxed">
                  Select a past study session from the sidebar or start a new one to begin learning.
                </p>
                <div className="pt-8">
                  <button 
                    onClick={() => setShowSubjectModal(true)}
                    className="px-8 py-4 bg-white text-black font-bold rounded-2xl hover:bg-white/90 transition-all hover:scale-105 active:scale-95 shadow-xl shadow-white/5"
                  >
                    Start New Session
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Subject Selection Modal */}
      <AnimatePresence>
        {showSubjectModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSubjectModal(false)}
              className="absolute inset-0 bg-[#000]/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full max-w-2xl bg-[#1a1a1a] border border-white/10 rounded-3xl p-8 shadow-2xl overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-4">
                <button onClick={() => setShowSubjectModal(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                  <X className="w-6 h-6 text-gray-500" />
                </button>
              </div>
              
              <div className="space-y-8">
                <div className="space-y-2">
                  <h3 className="text-3xl font-bold">New Chat</h3>
                  <p className="text-text-second text-sm">Select a subject to start a new Class 10 study session.</p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {['Maths', 'Science', 'Social Science', 'English', 'Hindi', 'Computer Science'].map(sub => (
                    <button
                      key={sub}
                      onClick={() => createNewChat(sub)}
                      className="group p-5 bg-surface-light border border-border-dim rounded-xl hover:bg-accent-blue/10 hover:border-accent-blue transition-all text-left space-y-3"
                    >
                      <div className="font-bold text-lg text-text-prime group-hover:text-accent-blue transition-colors">{sub}</div>
                    </button>
                  ))}
                </div>

                <div className="pt-4">
                  <label className="block text-[11px] font-bold text-text-second uppercase tracking-wider mb-3 px-1">Or Enter Subject Manually</label>
                  <input 
                    type="text" 
                    placeholder="Enter subject name..."
                    className="w-full bg-surface-light border border-border-dim rounded-lg px-4 py-3 focus:outline-none focus:ring-1 focus:ring-accent-blue text-text-prime transition-all"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                         createNewChat((e.target as HTMLInputElement).value);
                      }
                    }}
                  />
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Sub-components ---

function ChatInput({ onSend, disabled }: { onSend: (val: string) => void, disabled: boolean }) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  };

  const handleSend = () => {
    if (value.trim() && !disabled) {
      onSend(value);
      setValue('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  return (
    <div className="relative flex-1">
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => { setValue(e.target.value); adjustHeight(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Ask your Class 10 tutor about the material..."
        className="w-full bg-transparent px-2 py-1 resize-none focus:outline-none text-[15px] max-h-48 overflow-y-auto text-text-prime"
      />
      <div className="absolute right-0 bottom-0">
        <button
          onClick={handleSend}
          disabled={!value.trim() || disabled}
          className="p-1.5 text-text-second hover:text-accent-blue transition-colors disabled:opacity-30"
        >
          {disabled ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
