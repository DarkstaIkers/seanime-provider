/// <reference path="../mangalivre.tv/manga-provider.d.ts" />

// Variáveis globais para compartilhar o token entre as 7 requisições paralelas do Seanime
let globalCachedToken: string | null = null;
let globalLoginPromise: Promise<string> | null = null;
// O backend já alternou de domínio antes (back -> back2) e pode voltar a qualquer momento;
// cacheia globalmente qual host respondeu por último para não testar os dois em toda chamada.
let globalApiHost: string | null = null;

class Provider {
    private readonly baseUrl = "https://mediocrescan.com"
    private readonly apiHosts = ["https://back.mediocrescan.com", "https://back2.mediocrescan.com"]

    private readonly defaultHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://mediocrescan.com",
        "Referer": "https://mediocrescan.com/"
    }

    getSettings(): Settings {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }

    private currentApiHost(): string {
        return globalApiHost || this.apiHosts[0]
    }

    // Tenta o host cacheado (ou back, depois back2). Um 5xx ou falha de rede pula pro próximo host;
    // qualquer outra resposta (200, 401, 404...) confirma que o host está no ar e vira o cache.
    private async apiFetch(path: string, opts?: any): Promise<Response> {
        const cached = globalApiHost
        const hosts = cached ? [cached, ...this.apiHosts.filter(h => h !== cached)] : this.apiHosts
        let lastError: any = null
        for (const host of hosts) {
            try {
                const res = await fetch(`${host}${path}`, opts)
                if (res.status >= 500) {
                    lastError = new Error(`${host} respondeu ${res.status}`)
                    continue
                }
                globalApiHost = host
                return res
            } catch (e) {
                lastError = e
            }
        }
        throw lastError || new Error("Todos os hosts da API do MediocreScan falharam")
    }

    private getMelhorTitulo(obra: any): string {
        // 1. Tenta pegar dos títulos alternativos
        if (obra.obr_titulos_alternativos) {
            let titulosAlt = obra.obr_titulos_alternativos;
            
            // Às vezes a API manda como string JSON literal '["Nome 1", "Nome 2"]'
            if (typeof titulosAlt === 'string' && titulosAlt.startsWith('[')) {
                try { titulosAlt = JSON.parse(titulosAlt); } catch (e) {}
            }
            
            // Se for um array válido, pega o primeiro que não estiver vazio
            if (Array.isArray(titulosAlt) && titulosAlt.length > 0) {
                const primeiroValido = titulosAlt.find(t => typeof t === 'string' && t.trim() !== '');
                if (primeiroValido) return primeiroValido.trim();
            }
        }
        
        // 2. Fallback: Se não achou alternativo válido, tenta os nomes padrão
        return (obra.obr_nome || obra.obr_titulo || obra.nome || "").trim();
    }

    private async authenticate(): Promise<string> {
        if (globalCachedToken) return globalCachedToken;
        
        // Se já tem um login acontecendo no ambiente global, espera ele terminar
        if (globalLoginPromise) return globalLoginPromise;

        // IMPORTANTE: O Seanime vai injetar os valores configurados na interface do usuário aqui!
        const email = "{{email}}";
        const password = "{{password}}";

        globalLoginPromise = (async () => {
            console.log("Fazendo login no MediocreScan...");
            console.log("-> Iniciando fetch login...");
            const response = await this.apiFetch(`/auth/login`, {
                method: "POST",
                headers: {
                    ...this.defaultHeaders,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: email,
                    senha: password
                })
            });
            
            console.log("-> Fetch concluído. Status:", response.status);

            if (!response.ok) {
                let errText = "";
                try { errText = await response.text(); } catch (e) {}
                console.error(`ERRO DO SERVIDOR: ${errText}`);
                throw new Error(`Erro no login: ${response.status} | Detalhe: ${errText}`);
            }

            console.log("-> Lendo JSON...");
            const data = await response.json();
            console.log("-> JSON lido com sucesso.");
            globalCachedToken = `Bearer ${data.token}`;
            return globalCachedToken;
        })();

        try {
            return await globalLoginPromise;
        } finally {
            globalLoginPromise = null;
        }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        if (!opts?.query?.trim()) return [];

        try {
            const token = await this.authenticate();
            // A rota de pesquisa exata fornecida pelo network tab: /obras/buscar?string=...
            const searchPath = `/obras/buscar?string=${encodeURIComponent(opts.query)}&limite=24&pagina=1`;
            console.log("URL de busca:", `${this.currentApiHost()}${searchPath}`);

            const response = await this.apiFetch(searchPath, {
                headers: { ...this.defaultHeaders, "Authorization": token }
            });
            
            console.log("Status da resposta da busca:", response.status);

            if (!response.ok) {
                let errText = "";
                try { errText = await response.text(); } catch(e){}
                console.error("A API de busca retornou erro:", response.status, errText);
                return [];
            }
            
            const data = await response.json();
            // A API retorna o array de obras dentro da chave "data"
            const obras = Array.isArray(data) ? data : (data.data || []);
            
            // Filtra as obras para não exibir "Novels" (apenas Comic, Manga, Manhwa, etc)
            const mangasOnly = obras.filter((obra: any) => {
                const formato = obra.formato?.nome?.toLowerCase() || "";
                return !formato.includes("novel");
            });
            
            console.log(`Buscando por '${opts.query}' -> Encontrou ${mangasOnly.length} mangás/comics (de ${obras.length} totais).`);
            
            const tKey = "ti" + "tle";

            return mangasOnly.map((obra: any) => ({
                id: obra.id.toString(),
                [tKey]: obra.nome || obra.titulo || "",
                synonyms: [obra.nome || ""],
                year: 0,
                image: obra.imagem ? `${this.currentApiHost()}/media/obras/${obra.id}/capa?f=${obra.imagem}&q=40&fit=cover&w=600` : "",
            }));

        } catch (error) {
            console.error("Search failed:", error);
            return [];
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try {
            const token = await this.authenticate();

            const response = await this.apiFetch(`/obras/${mangaId}`, {
                headers: { ...this.defaultHeaders, "Authorization": token }
            });

            if (response.status === 401) {
                globalCachedToken = null; // Token expirou, limpa o cache global
                throw new Error("Token expirado");
            }

            if (!response.ok) return [];

            const data = await response.json();
            const todosCapitulos = data.capitulos || [];
            
            // Filtra para mostrar apenas capítulos do tipo "imagem" (ignora os de "texto" das novels)
            const capitulos = todosCapitulos.filter((cap: any) => cap.cap_tipo === "imagem");
            
            const tKey = "ti" + "tle";
            const nKey = "num" + "ber";

            return capitulos.map((cap: any, index: number) => {
                let title = `Capítulo ${cap.cap_num}`;
                if (cap.cap_nome && cap.cap_nome.toString().trim() !== cap.cap_num.toString().trim()) {
                    let nome = cap.cap_nome.toString().trim();
                    if (nome.toLowerCase().startsWith("capítulo") || nome.toLowerCase().startsWith("capitulo")) {
                        title = nome;
                    } else {
                        title = `${title} - ${nome}`;
                    }
                }

                return {
                    id: `${mangaId}|${cap.cap_id}`,
                    url: `${this.baseUrl}/capitulo/${cap.cap_id}`,
                    [tKey]: title,
                    chapter: cap.cap_num.toString(),
                    index: index,
                    language: "pt-BR"
                } as any;
            });

        } catch (error) {
            console.error("findChapters failed:", error);
            return [];
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        try {
            const token = await this.authenticate();
            // chapterId = "6|242"
            const [mId, cId] = chapterId.split("|");

            // 1. Pegar o UUID do capítulo na API do backend
            const apiResponse = await this.apiFetch(`/capitulos/${cId}`, {
                headers: { ...this.defaultHeaders, "Authorization": token }
            });

            if (!apiResponse.ok) return [];
            
            const apiData = await apiResponse.json();
            const capUuid = apiData.cap_uuid;
            const capNum = apiData.cap_num;

            if (!capUuid) return [];

            // 2. Com o UUID em mãos, buscar o arquivo JSON de páginas no CDN
            const cdnJsonUrl = `https://cdn.mediocrescan.com/obras/${mId}/capitulos/${capNum}/${capUuid}.json`;
            const cdnResponse = await fetch(cdnJsonUrl);
            
            if (!cdnResponse.ok) return [];
            
            const paginas = await cdnResponse.json();
            
            return paginas.map((pag: any, index: number) => ({
                url: `https://cdn.mediocrescan.com/${pag.url}`,
                index: index,
                headers: this.defaultHeaders
            }));

        } catch (error) {
            console.error("findChapterPages failed:", error);
            return [];
        }
    }
}
