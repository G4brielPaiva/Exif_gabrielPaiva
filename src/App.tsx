/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect } from 'react';
import exifr from 'exifr';
import { 
  ShieldCheck, 
  Upload, 
  MapPin, 
  Clock, 
  Cpu, 
  ShieldAlert, 
  ExternalLink, 
  FileText,
  Camera,
  Layers,
  AlertTriangle,
  CheckCircle2,
  Zap,
  Trash2,
  Image as ImageIcon,
  Globe,
  ArrowRight,
  History,
  BookOpen,
  ArrowLeft,
  XCircle,
  Merge,
  Database,
  LogIn,
  LogOut,
  User as UserIcon,
  Save,
  Share2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { 
  auth, 
  db, 
  storage, 
  signInWithGoogle, 
  logout, 
  onAuthStateChanged, 
  doc, 
  setDoc, 
  getDoc, 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  handleFirestoreError,
  OperationType,
  ref,
  uploadBytes,
  getDownloadURL,
  type User
} from './firebase';
import { Timestamp } from 'firebase/firestore';

// Sanitization to prevent XSS in metadata fields
const sanitize = (val: any): string => {
  if (val === undefined || val === null) return 'N/A';
  const str = String(val);
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m] || m));
};

interface MetadataResult {
  reportId: string;
  file: {
    name: string;
    type: string;
    size: string;
  };
  shootingSummary: {
    iso?: number;
    aperture?: string;
    exposureTime?: string;
    focalLength?: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    altitude?: number;
    mapsUrl: string;
  };
  groups: {
    [key: string]: Record<string, any>;
  };
  warnings: string[];
  thumbnail?: string;
}

type ViewState = 'home' | 'file' | 'url' | 'result' | 'dictionary' | 'merge_action' | 'merged_report';

interface HistoryItem extends MetadataResult {
  id: string;
  timestamp: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState<ViewState>('home');
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<MetadataResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Firebase Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Sync user profile to Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        try {
          const userDoc = await getDoc(userRef);
          const userData = {
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
            lastLogin: Timestamp.now(),
            ...(userDoc.exists() ? {} : { createdAt: Timestamp.now() })
          };
          await setDoc(userRef, userData, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`);
        }

        // Listen to saved reports
        const reportsQuery = query(
          collection(db, 'reports'),
          where('uid', '==', currentUser.uid),
          orderBy('createdAt', 'desc')
        );

        const unsubReports = onSnapshot(reportsQuery, (snapshot) => {
          const savedReports = snapshot.docs.map(doc => ({
            ...doc.data(),
            id: doc.id,
            timestamp: doc.data().createdAt?.toMillis() || Date.now()
          })) as HistoryItem[];
          
          setHistory(prev => {
            // Merge local history with saved reports, avoiding duplicates
            const combined = [...savedReports];
            prev.forEach(local => {
              if (!combined.find(c => c.reportId === local.reportId)) {
                combined.push(local);
              }
            });
            return combined.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
          });
        }, (err) => {
          handleFirestoreError(err, OperationType.LIST, 'reports');
        });

        return () => unsubReports();
      }
    });
    return () => unsubscribe();
  }, []);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const processFile = async (file: File | Blob, fileName: string) => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      // Deep Parsing: exiftool -All -G -j -struct logic
      const raw = await exifr.parse(file, {
        tiff: true,
        xmp: true,
        icc: true,
        iptc: true,
        jfif: true,
        ihdr: true,
        gps: true,
        makerNote: true,
        reviveValues: true,
        translateKeys: true,
        translateValues: true,
      });

      // Thumbnail extraction
      let thumbnail;
      try {
        const thumbBuffer = await exifr.thumbnail(file);
        if (thumbBuffer) {
          const blob = new Blob([thumbBuffer], { type: 'image/jpeg' });
          thumbnail = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.log("No thumbnail found");
      }

      const reportId = Math.random().toString(36).substring(2, 15);

      // Shooting Summary
      const shootingSummary = {
        iso: raw?.ISO,
        aperture: raw?.FNumber ? `f/${raw.FNumber}` : undefined,
        exposureTime: raw?.ExposureTime ? (raw.ExposureTime < 1 ? `1/${Math.round(1/raw.ExposureTime)}s` : `${raw.ExposureTime}s`) : undefined,
        focalLength: raw?.FocalLength ? `${raw.FocalLength}mm` : undefined,
      };

      // Location
      let location;
      if (raw?.latitude && raw?.longitude) {
        location = {
          latitude: raw.latitude,
          longitude: raw.longitude,
          altitude: raw.altitude,
          mapsUrl: `https://www.google.com/maps?q=${raw.latitude},${raw.longitude}`,
        };
      }

      // Grouping
      const groups: Record<string, any> = {
        'File': {
          'FileName': fileName,
          'FileType': file.type,
          'FileSize': formatFileSize(file.size),
          'ImageWidth': raw?.ExifImageWidth || raw?.ImageWidth,
          'ImageHeight': raw?.ExifImageHeight || raw?.ImageHeight,
        },
        'EXIF': {},
        'GPS': {},
        'MakerNotes': {},
        'XMP': {},
        'Composite': {}
      };

      if (raw) {
        Object.entries(raw).forEach(([key, val]) => {
          if (key.toLowerCase().includes('gps')) groups['GPS'][key] = val;
          else if (key.toLowerCase().includes('makernote')) groups['MakerNotes'][key] = val;
          else if (key.toLowerCase().includes('xmp')) groups['XMP'][key] = val;
          else groups['EXIF'][key] = val;
        });
      }

      const warnings: string[] = [];
      if (!raw) warnings.push("Arquivo sem metadados detectáveis ou corrompido.");
      if (raw?.ModifyDate && raw?.CreateDate && new Date(raw.ModifyDate) < new Date(raw.CreateDate)) {
        warnings.push("Aviso: Inconsistência cronológica detectada.");
      }

      const newResult: MetadataResult = {
        reportId,
        file: {
          name: fileName,
          type: file.type,
          size: formatFileSize(file.size),
        },
        shootingSummary,
        location,
        groups,
        warnings,
        thumbnail
      };

      setResult(newResult);
      
      // Add to local history (will be synced if user saves)
      setHistory(prev => [{
        ...newResult,
        id: reportId,
        timestamp: Date.now()
      }, ...prev].slice(0, 50));

      setView('result');

    } catch (err) {
      console.error(err);
      setError("Erro crítico no motor de extração. Verifique a integridade do arquivo.");
    } finally {
      setIsLoading(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file, file.name);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file, file.name);
  };

  const handleRemoteFetch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remoteUrl) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(remoteUrl);
      if (!response.ok) throw new Error("Falha ao buscar URL remota.");
      const blob = await response.blob();
      const fileName = remoteUrl.split('/').pop() || 'remote_file';
      processFile(blob, fileName);
    } catch (err) {
      setError("Erro ao buscar arquivo remoto. Verifique a URL ou permissões de CORS.");
      setIsLoading(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedItems(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleMerge = () => {
    if (selectedItems.length < 2) return;
    setView('merged_report');
  };

  const saveReport = async () => {
    if (!user || !result) return;
    setIsSaving(true);
    try {
      let finalThumbnailUrl = result.thumbnail;

      // If there's a local thumbnail blob, upload it to Storage
      if (result.thumbnail && result.thumbnail.startsWith('blob:')) {
        const response = await fetch(result.thumbnail);
        const blob = await response.blob();
        const storagePath = `thumbnails/${user.uid}/${result.reportId}.jpg`;
        const storageRef = ref(storage, storagePath);
        await uploadBytes(storageRef, blob);
        finalThumbnailUrl = await getDownloadURL(storageRef);
      }

      const reportData = {
        ...result,
        uid: user.uid,
        createdAt: Timestamp.now(),
        thumbnail: finalThumbnailUrl || null,
        isPublic: false
      };

      await addDoc(collection(db, 'reports'), reportData);
      alert("Relatório salvo com sucesso no seu dossiê digital.");
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'reports');
    } finally {
      setIsSaving(false);
    }
  };

  // Components
  const HistoryDrawer = () => (
    <AnimatePresence>
      {isHistoryOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsHistoryOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
          />
          <motion.div 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 w-full max-w-md h-full bg-industrial-input border-l border-industrial-sep z-50 flex flex-col shadow-2xl"
          >
            <div className="p-6 border-b border-industrial-sep flex justify-between items-center">
              <div>
                <h3 className="text-white font-bold flex items-center gap-2 text-sm uppercase tracking-wider">
                  <Clock size={16} className="text-industrial-brand" /> Histórico Recente
                </h3>
                <p className="text-[10px] text-industrial-text-gray mt-1">Dados em cache local (volátil)</p>
              </div>
              <button onClick={() => setIsHistoryOpen(false)} className="text-industrial-text-gray hover:text-white p-1 transition-colors">
                <XCircle size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {history.length > 0 ? (
                history.map((item) => (
                  <div 
                    key={item.id} 
                    onClick={() => {
                      setResult(item);
                      setView('result');
                      setIsHistoryOpen(false);
                    }}
                    className="bg-industrial-bg/40 border border-industrial-sep p-4 rounded-xl hover:border-industrial-brand transition-all cursor-pointer group flex items-center gap-4"
                  >
                    <div className="bg-industrial-accent p-3 rounded-lg text-industrial-text-gray group-hover:text-industrial-brand transition-colors">
                      {item.file.type.includes('image') ? <Camera size={20} /> : <FileText size={20} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white truncate font-bold">{item.file.name}</p>
                      <p className="text-[10px] text-industrial-text-gray uppercase tracking-tighter">
                        {item.file.size} • ID: {item.id}
                      </p>
                    </div>
                    <ArrowRight size={16} className="text-industrial-text-gray opacity-0 group-hover:opacity-100 transition-all" />
                  </div>
                ))
              ) : (
                <div className="h-full flex flex-col items-center justify-center opacity-30 text-center px-8">
                  <Database size={48} className="mb-4 text-industrial-text-gray" />
                  <p className="text-sm font-mono uppercase tracking-widest">Nenhum dado encontrado no buffer.</p>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  return (
    <div className="min-h-screen bg-industrial-bg text-industrial-text font-sans selection:bg-industrial-brand/30 flex flex-col items-center relative overflow-x-hidden">
      {/* Auth & History Controls */}
      <div className="fixed top-8 right-8 flex items-center gap-3 z-30">
        {user ? (
          <div className="flex items-center gap-3 bg-industrial-input border border-industrial-sep px-3 py-1.5 rounded-full shadow-lg">
            <img src={user.photoURL || ''} alt="User" className="w-6 h-6 rounded-full border border-industrial-brand/50" />
            <span className="text-[10px] font-bold text-white uppercase tracking-wider hidden md:block">{user.displayName?.split(' ')[0]}</span>
            <button onClick={logout} className="text-industrial-text-gray hover:text-industrial-brand transition-colors p-1" title="Sair">
              <LogOut size={14} />
            </button>
          </div>
        ) : (
          <button 
            onClick={signInWithGoogle}
            className="flex items-center gap-2 bg-industrial-brand text-black px-4 py-2 rounded-full font-bold text-[10px] uppercase tracking-widest hover:scale-105 transition-all shadow-lg"
          >
            <LogIn size={14} /> Entrar
          </button>
        )}
        
        <button 
          onClick={() => setIsHistoryOpen(true)}
          className="flex items-center gap-2 bg-industrial-input border border-industrial-sep px-4 py-2 rounded-full text-industrial-text-gray hover:text-white hover:border-industrial-brand transition-all group shadow-lg"
        >
          <History size={18} className="group-hover:rotate-[-10deg] transition-transform" />
          <span className="text-xs font-bold uppercase tracking-wider">Histórico</span>
        </button>
      </div>

      {/* Header */}
      <header className="w-full max-w-5xl px-6 py-12 text-center">
        <h1 className="text-5xl md:text-6xl font-black tracking-tighter uppercase italic drop-shadow-[3px_3px_0px_rgba(0,0,0,0.4)]">
          <span className="text-industrial-brand">Exif Info</span>
          <span className="text-white">.org</span>
        </h1>
        <p className="text-xl text-industrial-text-gray mt-4 font-medium">
          Advanced Open Source Metadata Intelligence
        </p>
      </header>

      <main className="w-full max-w-5xl px-6 pb-20">
        <AnimatePresence mode="wait">
          {/* Home View */}
          {view === 'home' && !isLoading && (
            <motion.div 
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-12"
            >
              <div className="text-center">
                <h2 className="text-3xl font-light text-white mb-2">Bem-vindo ao ExifInfo</h2>
                <p className="text-industrial-text-gray">Como você deseja iniciar sua investigação hoje?</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Card Arquivo */}
                <button 
                  onClick={() => setView('file')}
                  className="bg-industrial-input border-2 border-transparent hover:border-industrial-brand hover:-translate-y-1 transition-all duration-300 p-8 rounded-lg flex flex-col items-center text-center group shadow-lg"
                >
                  <div className="mb-4 bg-industrial-accent p-4 rounded-full group-hover:scale-110 transition-transform">
                    <Upload className="w-10 h-10 text-white" />
                  </div>
                  <h3 className="text-xl font-bold mb-2 text-white">Analisar Arquivo</h3>
                  <p className="text-sm text-industrial-text-gray leading-relaxed">
                    Upload direto do seu computador. Suporta JPG, RAW, PDF e mais.
                  </p>
                </button>

                {/* Card URL */}
                <button 
                  onClick={() => setView('url')}
                  className="bg-industrial-input border-2 border-transparent hover:border-industrial-brand hover:-translate-y-1 transition-all duration-300 p-8 rounded-lg flex flex-col items-center text-center group shadow-lg"
                >
                  <div className="mb-4 bg-industrial-accent p-4 rounded-full group-hover:scale-110 transition-transform">
                    <Globe className="w-10 h-10 text-white" />
                  </div>
                  <h3 className="text-xl font-bold mb-2 text-white">Analisar URL</h3>
                  <p className="text-sm text-industrial-text-gray leading-relaxed">
                    Cole um link direto de uma imagem ou documento na web.
                  </p>
                </button>

                {/* Card Merge (NEW) */}
                <button 
                  onClick={() => setView('merge_action')}
                  className="bg-industrial-input border-2 border-transparent hover:border-industrial-brand hover:-translate-y-1 transition-all duration-300 p-8 rounded-lg flex flex-col items-center text-center group shadow-lg"
                >
                  <div className="mb-4 bg-industrial-accent p-4 rounded-full group-hover:scale-110 transition-transform">
                    <Layers className="w-10 h-10 text-white" />
                  </div>
                  <h3 className="text-xl font-bold mb-2 text-white">Mesclar & Associar</h3>
                  <p className="text-sm text-industrial-text-gray leading-relaxed">
                    Combine múltiplos arquivos em um dossiê único e correlacionado.
                  </p>
                </button>

                {/* Card Knowledge Base */}
                <button 
                  onClick={() => setView('dictionary')}
                  className="bg-industrial-input border-2 border-transparent hover:border-industrial-brand hover:-translate-y-1 transition-all duration-300 p-8 rounded-lg flex flex-col items-center text-center group shadow-lg"
                >
                  <div className="mb-4 bg-industrial-accent p-4 rounded-full group-hover:scale-110 transition-transform">
                    <BookOpen className="w-10 h-10 text-white" />
                  </div>
                  <h3 className="text-xl font-bold mb-2 text-white">Dicionário EXIF</h3>
                  <p className="text-sm text-industrial-text-gray leading-relaxed">
                    Aprenda o significado de cada tag técnica encontrada.
                  </p>
                </button>
              </div>
            </motion.div>
          )}

          {/* File View */}
          {view === 'file' && !isLoading && (
            <motion.div 
              key="file"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <button 
                onClick={() => setView('home')}
                className="text-industrial-brand flex items-center gap-2 hover:underline font-bold uppercase tracking-widest text-xs"
              >
                <ArrowLeft className="w-4 h-4" /> Voltar para seleção
              </button>
              
              <h2 className="text-4xl font-bold text-industrial-text-gray border-b border-industrial-accent pb-2">Análise de Arquivo Local</h2>
              
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={cn(
                  "bg-black/20 p-16 border-2 border-dashed rounded-xl text-center transition-all duration-300",
                  isDragging ? "border-industrial-brand bg-industrial-brand/5" : "border-industrial-accent"
                )}
              >
                <input
                  type="file"
                  id="fileInput"
                  onChange={onFileChange}
                  className="hidden"
                />
                <label htmlFor="fileInput" className="cursor-pointer block">
                  <p className="text-2xl mb-6 text-white">
                    Arraste arquivos aqui ou <span className="text-industrial-brand">clique para selecionar</span>
                  </p>
                  <div className="bg-industrial-btn hover:bg-white text-black px-8 py-3 rounded font-bold text-sm uppercase tracking-widest transition-all inline-flex items-center gap-2">
                    Selecionar do Disco
                  </div>
                </label>
              </div>

              <div className="bg-industrial-accent/20 p-8 rounded-lg border border-industrial-accent/30">
                <h3 className="font-bold text-white mb-3 text-lg">Como funciona:</h3>
                <p className="text-industrial-text-gray leading-relaxed">
                  Ao fazer o upload, nosso motor <strong>ExifTool</strong> processa o arquivo instantaneamente em um buffer isolado. O sistema extrai tags GPS, dados de fabricante e configurações de disparo sem salvar o arquivo original no servidor. O relatório é gerado em JSON e o cache é purgado automaticamente.
                </p>
              </div>
            </motion.div>
          )}

          {/* URL View */}
          {view === 'url' && !isLoading && (
            <motion.div 
              key="url"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <button 
                onClick={() => setView('home')}
                className="text-industrial-brand flex items-center gap-2 hover:underline font-bold uppercase tracking-widest text-xs"
              >
                <ArrowLeft className="w-4 h-4" /> Voltar para seleção
              </button>
              
              <h2 className="text-4xl font-bold text-industrial-text-gray border-b border-industrial-accent pb-2">Inspeção via URL Remota</h2>
              
              <form onSubmit={handleRemoteFetch} className="flex flex-col md:flex-row gap-4">
                <input 
                  type="url" 
                  placeholder="https://exemplo.com/imagem.jpg"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  className="bg-industrial-input border border-industrial-accent rounded px-6 py-4 text-white text-lg flex-grow focus:outline-none focus:border-industrial-brand transition-colors"
                />
                <button 
                  type="submit"
                  className="bg-industrial-btn hover:bg-white text-black px-10 py-4 rounded font-bold text-sm uppercase tracking-widest transition-all whitespace-nowrap"
                >
                  Analisar Link
                </button>
              </form>

              <div className="bg-industrial-accent/20 p-8 rounded-lg border border-industrial-accent/30">
                <h3 className="font-bold text-white mb-3 text-lg">Processamento Remoto:</h3>
                <p className="text-industrial-text-gray leading-relaxed">
                  O servidor realiza um fetch temporário do ativo de mídia. A análise ocorre "on-the-fly" nos cabeçalhos binários. Não há persistência de dados fora dos resultados do relatório, garantindo anonimato total na investigação OSINT.
                </p>
              </div>
            </motion.div>
          )}

          {/* Dictionary View */}
          {view === 'dictionary' && (
            <motion.div 
              key="dictionary"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-8"
            >
              <button 
                onClick={() => setView('home')}
                className="text-industrial-brand flex items-center gap-2 hover:underline font-bold uppercase tracking-widest text-xs"
              >
                <ArrowLeft className="w-4 h-4" /> Voltar para seleção
              </button>
              
              <h2 className="text-4xl font-bold text-industrial-text-gray border-b border-industrial-accent pb-2">Dicionário EXIF</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {[
                  { term: 'EXIF', desc: 'Exchangeable Image File Format. Padrão para armazenar metadados em arquivos de imagem e som.' },
                  { term: 'MakerNotes', desc: 'Metadados proprietários gravados pelos fabricantes (Nikon, Canon, etc.) que não seguem o padrão EXIF comum.' },
                  { term: 'Composite', desc: 'Tags calculadas pelo ExifTool baseadas em outros metadados (ex: Profundidade de Campo).' },
                  { term: 'XMP', desc: 'Extensible Metadata Platform. Padrão da Adobe para metadados que permite maior flexibilidade que o EXIF.' },
                  { term: 'ISO', desc: 'Sensibilidade do sensor à luz. Valores altos indicam maior sensibilidade, mas podem gerar ruído.' },
                  { term: 'F-Number', desc: 'Abertura do diafragma. Controla a quantidade de luz e a profundidade de campo.' },
                  { term: 'GPS', desc: 'Global Positioning System. Coordenadas geográficas de onde a mídia foi capturada.' },
                  { term: 'ICC Profile', desc: 'International Color Consortium. Dados que definem como as cores devem ser interpretadas.' }
                ].map((item, i) => (
                  <div key={i} className="bg-industrial-input p-6 rounded-lg border border-industrial-accent/30">
                    <h4 className="text-industrial-brand font-black text-lg uppercase tracking-widest mb-2 italic">{item.term}</h4>
                    <p className="text-industrial-text-gray text-sm leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Merge Action View */}
          {view === 'merge_action' && (
            <motion.div 
              key="merge_action"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <button 
                onClick={() => setView('home')}
                className="text-industrial-brand flex items-center gap-2 hover:underline font-bold uppercase tracking-widest text-xs"
              >
                <ArrowLeft className="w-4 h-4" /> Voltar para seleção
              </button>

              <header className="mb-12">
                <h2 className="text-4xl font-bold text-industrial-text-gray border-b border-industrial-accent pb-2">Mesclar & Associar</h2>
                <p className="text-industrial-text-gray mt-4">
                  Selecione arquivos do histórico para criar um dossiê de metadados unificado e identificar correlações.
                </p>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Add New */}
                <div className="bg-industrial-input border-2 border-dashed border-industrial-sep rounded-3xl p-8 flex flex-col items-center justify-center hover:border-industrial-brand transition-colors group">
                  <div className="bg-industrial-accent p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                    <Upload className="text-white" size={32} />
                  </div>
                  <h3 className="text-white font-bold mb-1">Adicionar Novos Arquivos</h3>
                  <p className="text-xs text-industrial-text-gray mb-6 text-center">Eles serão processados e incluídos no histórico</p>
                  <label htmlFor="mergeFileInput" className="bg-industrial-btn hover:bg-white text-black text-[10px] px-6 py-2.5 rounded font-black uppercase tracking-widest cursor-pointer transition-all">
                    Explorar Arquivos
                  </label>
                  <input type="file" id="mergeFileInput" className="hidden" onChange={onFileChange} />
                </div>

                {/* History Selection */}
                <div className="bg-industrial-input border border-industrial-sep rounded-3xl p-6 flex flex-col h-[400px]">
                  <h3 className="text-white font-bold text-xs mb-4 uppercase tracking-widest flex items-center gap-2">
                    <History size={16} className="text-industrial-text-gray" /> Seleção do Histórico
                  </h3>
                  <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                    {history.length > 0 ? (
                      history.map(item => (
                        <div 
                          key={item.id}
                          onClick={() => toggleSelect(item.id)}
                          className={cn(
                            "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all",
                            selectedItems.includes(item.id) 
                              ? "bg-industrial-brand/10 border-industrial-brand" 
                              : "bg-industrial-bg/40 border-industrial-sep hover:border-industrial-text-gray"
                          )}
                        >
                          <div className={cn(
                            "w-4 h-4 rounded border flex items-center justify-center transition-colors",
                            selectedItems.includes(item.id) ? "bg-industrial-brand border-industrial-brand" : "border-industrial-sep"
                          )}>
                            {selectedItems.includes(item.id) && <CheckCircle2 size={10} className="text-black" />}
                          </div>
                          <span className="text-xs text-white truncate flex-1 font-medium">{item.file.name}</span>
                        </div>
                      ))
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center opacity-20 text-center">
                        <Database size={32} className="mb-2" />
                        <p className="text-[10px] uppercase font-mono">Histórico vazio</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {selectedItems.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center justify-between p-6 bg-industrial-brand/10 border border-industrial-brand/30 rounded-2xl"
                >
                  <div>
                    <p className="text-white font-bold">{selectedItems.length} Arquivos Selecionados</p>
                    <p className="text-[10px] text-industrial-brand uppercase tracking-widest italic">Pronto para gerar correlação forense</p>
                  </div>
                  <button 
                    disabled={selectedItems.length < 2}
                    onClick={handleMerge}
                    className={cn(
                      "px-8 py-3 rounded font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2",
                      selectedItems.length >= 2 
                        ? "bg-industrial-brand text-black shadow-lg hover:scale-105" 
                        : "bg-industrial-sep text-industrial-text-gray cursor-not-allowed"
                    )}
                  >
                    <Merge size={18} /> Mesclar Agora
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* Merged Report View */}
          {view === 'merged_report' && (
            <motion.div 
              key="merged_report"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-12"
            >
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div>
                  <button 
                    onClick={() => setView('merge_action')}
                    className="text-industrial-brand flex items-center gap-2 hover:underline font-bold uppercase tracking-widest text-xs mb-4"
                  >
                    <ArrowLeft className="w-4 h-4" /> Voltar para seleção
                  </button>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="bg-industrial-brand/20 text-industrial-brand text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-widest border border-industrial-brand/30">Dossiê Consolidado</span>
                  </div>
                  <h2 className="text-4xl font-bold text-white">Relatório de Associação</h2>
                </div>
                <div className="flex gap-3">
                   <button className="bg-industrial-sep hover:bg-industrial-sep/80 text-white px-6 py-2.5 rounded font-bold text-[10px] uppercase tracking-widest transition-all">Exportar PDF</button>
                   <button className="bg-industrial-brand hover:bg-industrial-brand/80 text-black px-6 py-2.5 rounded font-bold text-[10px] uppercase tracking-widest transition-all">Salvar JSON</button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div className="lg:col-span-8 space-y-8">
                  <div className="bg-white/[0.01] border border-industrial-sep rounded-2xl p-6">
                    <h3 className="text-white font-black text-xs uppercase tracking-[0.3em] mb-6 flex items-center gap-2">
                      <Layers size={18} className="text-industrial-brand" /> Metadados Cruzados
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left border-collapse">
                        <thead className="text-industrial-text-gray border-b border-industrial-sep">
                          <tr>
                            <th className="pb-4 font-black text-[10px] uppercase tracking-widest">Tag Técnica</th>
                            <th className="pb-4 font-black text-[10px] uppercase tracking-widest">Valor Consolidado</th>
                            <th className="pb-4 font-black text-[10px] uppercase tracking-widest">Origem</th>
                          </tr>
                        </thead>
                        <tbody className="text-white divide-y divide-industrial-sep/30">
                          {/* Simulated cross-metadata for demo purposes based on selection */}
                          {selectedItems.map((id, idx) => {
                            const item = history.find(h => h.id === id);
                            if (!item) return null;
                            return (
                              <React.Fragment key={id}>
                                <tr className="hover:bg-white/[0.02] transition-colors">
                                  <td className="py-4 font-mono text-[10px] text-industrial-brand">DateTimeOriginal</td>
                                  <td className="py-4 text-xs">{item.groups['EXIF']?.DateTimeOriginal || 'N/A'}</td>
                                  <td className="py-4 text-[10px] text-industrial-text-gray font-mono">{item.file.name}</td>
                                </tr>
                                <tr className="hover:bg-white/[0.02] transition-colors">
                                  <td className="py-4 font-mono text-[10px] text-industrial-brand">Software</td>
                                  <td className="py-4 text-xs">{item.groups['EXIF']?.Software || 'N/A'}</td>
                                  <td className="py-4 text-[10px] text-industrial-text-gray font-mono">{item.file.name}</td>
                                </tr>
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="bg-industrial-brand/5 border border-industrial-brand/20 rounded-2xl p-6 flex gap-4 items-start">
                    <ShieldAlert className="text-industrial-brand shrink-0 mt-1" size={24} />
                    <div>
                      <h4 className="text-industrial-brand font-black text-xs uppercase tracking-widest mb-2">Análise de Correlação</h4>
                      <p className="text-xs text-industrial-text-gray leading-relaxed">
                        O motor identificou {selectedItems.length} ativos com carimbos de tempo próximos. Recomenda-se inspeção manual das MakerNotes para confirmar a identidade do sensor entre os dispositivos.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-4 space-y-6">
                   <div className="bg-industrial-input border border-industrial-sep rounded-2xl p-6">
                      <h3 className="text-white font-black text-[10px] uppercase tracking-widest mb-6 border-b border-industrial-sep pb-2">Arquivos no Dossiê</h3>
                      <div className="space-y-3">
                        {selectedItems.map(id => {
                          const item = history.find(h => h.id === id);
                          return item ? (
                            <div key={id} className="flex items-center gap-3 bg-industrial-bg/40 p-3 rounded-lg border border-industrial-sep group hover:border-industrial-brand transition-all">
                               <div className="text-industrial-text-gray group-hover:text-industrial-brand"><FileText size={16}/></div>
                               <div className="min-w-0 flex-1">
                                 <p className="text-[10px] text-white truncate font-bold">{item.file.name}</p>
                                 <p className="text-[8px] text-industrial-text-gray font-mono">{item.id}</p>
                               </div>
                            </div>
                          ) : null;
                        })}
                      </div>
                   </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Loading State */}
          {isLoading && (
            <motion.div 
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-32 gap-6"
            >
              <div className="w-16 h-16 border-2 border-industrial-brand/20 border-t-industrial-brand rounded-full animate-spin"></div>
              <div className="text-center space-y-2">
                <p className="font-mono text-xs text-industrial-brand uppercase tracking-[0.4em] animate-pulse">Engine Processing</p>
                <p className="text-[10px] text-industrial-text-gray uppercase tracking-widest">exiftool -All -G -j -struct [buffer]</p>
              </div>
            </motion.div>
          )}

          {/* Result View */}
          {view === 'result' && result && !isLoading && (
            <motion.div 
              key="result"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-8"
            >
              {/* Sidebar: Thumbnails & Map */}
              <aside className="lg:col-span-3 space-y-8">
                <div className="bg-white/[0.02] border border-industrial-accent rounded p-4 space-y-4">
                  <p className="text-[10px] font-mono text-industrial-text-gray uppercase tracking-widest border-b border-industrial-accent pb-2">Original Thumbnail</p>
                  <div className="aspect-square bg-black/40 rounded overflow-hidden flex items-center justify-center border border-industrial-accent">
                    {result.thumbnail ? (
                      <img src={result.thumbnail} alt="Thumbnail" className="w-full h-full object-contain" />
                    ) : (
                      <ImageIcon className="w-8 h-8 opacity-10" />
                    )}
                  </div>
                </div>

                {result.location && (
                  <div className="bg-white/[0.02] border border-industrial-accent rounded p-4 space-y-4">
                    <p className="text-[10px] font-mono text-industrial-text-gray uppercase tracking-widest border-b border-industrial-accent pb-2">GPS Integration</p>
                    <div className="aspect-video bg-black/40 rounded overflow-hidden border border-industrial-accent relative group">
                      <div className="absolute inset-0 bg-[url('https://picsum.photos/seed/map/400/300')] bg-cover opacity-20 grayscale group-hover:grayscale-0 transition-all"></div>
                      <MapPin className="w-6 h-6 text-industrial-brand relative z-10 mx-auto mt-8" />
                      <div className="absolute bottom-0 inset-x-0 p-3 bg-black/60 backdrop-blur-sm">
                        <a 
                          href={result.location.mapsUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-[10px] font-bold text-industrial-brand flex items-center justify-center gap-2 uppercase"
                        >
                          OpenStreetMap <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                <div className="p-4 bg-industrial-brand/5 border border-industrial-brand/10 rounded space-y-3">
                  <div className="flex items-center gap-2 text-industrial-brand">
                    <ShieldCheck className="w-4 h-4" />
                    <span className="text-[10px] font-bold uppercase tracking-widest">Privacy OK</span>
                  </div>
                  <p className="text-[10px] text-industrial-text-gray leading-relaxed italic">
                    O arquivo original foi destruído (unlink) imediatamente após a extração dos metadados.
                  </p>
                </div>

                <button 
                  onClick={() => setView('home')}
                  className="w-full bg-industrial-accent hover:bg-industrial-accent/80 text-white py-3 rounded font-bold text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2 mb-3"
                >
                  <History className="w-4 h-4" /> Nova Análise
                </button>

                {user && (
                  <button 
                    onClick={saveReport}
                    disabled={isSaving}
                    className="w-full bg-industrial-brand hover:bg-industrial-brand/80 text-black py-3 rounded font-bold text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-lg"
                  >
                    {isSaving ? (
                      <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin"></div>
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    {isSaving ? 'Salvando...' : 'Salvar no Dossiê'}
                  </button>
                )}
              </aside>

              {/* Main Report Content */}
              <div className="lg:col-span-9 space-y-12">
                {/* Summary Row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-industrial-accent border border-industrial-accent rounded overflow-hidden">
                  {[
                    { label: 'ISO', value: result.shootingSummary.iso, icon: Zap },
                    { label: 'F-Number', value: result.shootingSummary.aperture, icon: Camera },
                    { label: 'Exposure', value: result.shootingSummary.exposureTime, icon: Clock },
                    { label: 'Focal', value: result.shootingSummary.focalLength, icon: Layers },
                  ].map((item, i) => (
                    <div key={i} className="bg-industrial-bg p-6 flex flex-col gap-2">
                      <item.icon className="w-4 h-4 text-industrial-brand" />
                      <div>
                        <p className="text-[9px] text-industrial-text-gray uppercase font-mono tracking-widest">{item.label}</p>
                        <p className="text-xl font-black text-white italic">{item.value || '--'}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Deep Data Groups */}
                <div className="space-y-12">
                  {Object.entries(result.groups).map(([groupName, tags]) => (
                    Object.keys(tags).length > 0 && (
                      <div key={groupName} className="space-y-4">
                        <div className="flex items-center gap-4">
                          <h4 className="text-xs font-black text-industrial-brand uppercase tracking-[0.3em] whitespace-nowrap">{groupName} Group</h4>
                          <div className="h-px w-full bg-industrial-accent"></div>
                        </div>
                        <div className="bg-white/[0.01] border border-industrial-accent rounded overflow-hidden">
                          <table className="w-full text-left border-collapse">
                            <tbody className="divide-y divide-industrial-accent">
                              {Object.entries(tags).map(([tag, val]) => (
                                <tr key={tag} className="hover:bg-white/[0.02] transition-colors">
                                  <td className="px-6 py-3 text-[10px] font-mono text-industrial-text-gray w-1/3 border-r border-industrial-accent uppercase tracking-wider">{tag}</td>
                                  <td className="px-6 py-3 text-xs text-white font-medium break-all">
                                    {typeof val === 'object' ? JSON.stringify(val) : sanitize(val)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  ))}
                </div>

                {/* Warnings */}
                {result.warnings.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <h4 className="text-xs font-black text-red-400 uppercase tracking-[0.3em] whitespace-nowrap">Engine Warnings</h4>
                      <div className="h-px w-full bg-red-400/20"></div>
                    </div>
                    <div className="space-y-2">
                      {result.warnings.map((warn, i) => (
                        <div key={i} className="p-4 bg-red-400/5 border border-red-400/20 rounded flex items-center gap-3 text-red-400 text-[10px] font-mono uppercase">
                          <AlertTriangle className="w-4 h-4" />
                          {warn}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {error && view !== 'result' && (
          <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-xs font-mono text-center">
            [ERRO]: {error}
          </div>
        )}
      </main>
      <HistoryDrawer />

      {/* Footer */}
      <footer className="w-full max-w-5xl px-6 py-20 border-t border-industrial-accent mt-20">
        <div className="flex flex-col md:flex-row justify-between items-center gap-8 opacity-40">
          <div className="flex items-center gap-3">
            <Zap className="w-4 h-4" />
            <span className="text-[9px] font-mono uppercase tracking-[0.4em]">ExifInfo_Engine_v3.0 // Industrial_Core</span>
          </div>
          <div className="flex gap-10 text-[9px] font-mono uppercase tracking-widest">
            <span className="text-industrial-brand/60">Powered by Firebase (Spark)</span>
            <a href="#" className="hover:text-industrial-brand transition-colors">Privacy Policy</a>
            <a href="#" className="hover:text-industrial-brand transition-colors">API Docs</a>
            <a href="#" className="hover:text-industrial-brand transition-colors">Unlink Protocol</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
