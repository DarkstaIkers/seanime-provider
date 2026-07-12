/// <reference path="./manga-provider.d.ts" />

class Provider {
    private readonly baseUrl = "https://toonlivre.net"
    private readonly apiUrl = "https://toonlivre.net/api"
    private email = "{{email}}"
    private password = "{{password}}"

    // ponytail: site rotates both the header NAME and value (seen "x-tly-nexus" -> "x-tly-omega" in the wild).
    // Defaults below are just a starting point; refreshAntiBotHeader() re-derives both from the bundle on 403.
    private antiBotHeaderName = "x-tly-omega"
    private antiBotHeaderValue = "z11-break-x"

    private readonly defaultHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://toonlivre.net/",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
    }

    private getHeaders(extra?: Record<string, string>): Record<string, string> {
        return { ...this.defaultHeaders, [this.antiBotHeaderName]: this.antiBotHeaderValue, ...(extra || {}) }
    }

    // Fetches the main bundle to extract the current "x-tly-*" header name/value from obfuscated char-code arrays.
    // The bundle encodes the header name as a char-code array starting with [120,45,116,108,121,45,...] (="x-tly-" + suffix);
    // the array right after it is the rotating value. Suffix ("nexus", "omega", ...) itself rotates, so it isn't hardcoded.
    private async refreshAntiBotHeader(): Promise<void> {
        try {
            const homeRes = await fetch(this.baseUrl, {
                headers: {
                    "User-Agent": this.defaultHeaders["User-Agent"],
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "pt-BR,pt;q=0.9"
                }
            })
            if (!homeRes.ok) return
            const html = await homeRes.text()

            const bundleMatch = html.match(/["'](\/assets\/index-[A-Za-z0-9_\-]+\.js)["']/)
            if (!bundleMatch) return

            const bundleRes = await fetch(`${this.baseUrl}${bundleMatch[1]}`, {
                headers: { "User-Agent": this.defaultHeaders["User-Agent"] }
            })
            if (!bundleRes.ok) return
            const bundle = await bundleRes.text()

            // "x-tly-" prefix fixed, suffix (name codes) variable; next char-code array is the rotating value
            const m = bundle.match(/\[(120,45,116,108,121,45,\d+(?:,\d+)*)\][^[]+\[(\d+(?:,\d+)+)\]\.map\([^)]+String\.fromCharCode/)
            if (!m) return

            const decode = (codes: string) => codes.split(",").map((n: string) => String.fromCharCode(parseInt(n, 10))).join("")
            const decodedName = decode(m[1])
            const decodedValue = decode(m[2])
            if (decodedName && decodedValue) {
                this.antiBotHeaderName = decodedName
                this.antiBotHeaderValue = decodedValue
                console.log(`${decodedName} atualizado:`, decodedValue)
            }
        } catch (e) {
            console.error("refreshAntiBotHeader falhou:", e)
        }
    }

    private async getViewerCookie(): Promise<string> {
        const res = await fetch(this.baseUrl, { headers: this.getHeaders() })
        let cookie = ""
        if (typeof res.headers.get === "function") {
            cookie = res.headers.get("set-cookie") || ""
        } else {
            for (const k in res.headers as any) {
                if (k.toLowerCase() === "set-cookie") { cookie = (res.headers as any)[k]; break }
            }
        }
        const match = cookie.match(/tl_viewer=([^;]+)/)
        return match ? match[1] : ""
    }

    private hasCredentials(): boolean {
        return !!this.email && !!this.password && !this.email.startsWith("{{") && !this.password.startsWith("{{")
    }

    private async getToken(): Promise<string> {
        const res = await fetch(`${this.apiUrl}/auth/login`, {
            method: "POST",
            headers: this.getHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ email: this.email, password: this.password })
        })
        if (!res.ok) {
            const body = await res.text()
            throw `Login falhou: ${res.status} - ${body}`
        }
        let cookie = ""
        if (typeof res.headers.get === "function") {
            cookie = res.headers.get("set-cookie") || ""
        } else {
            for (const k in res.headers as any) {
                if (k.toLowerCase() === "set-cookie") { cookie = (res.headers as any)[k]; break }
            }
        }
        const match = cookie.match(/access_token=([^;]+)/)
        if (!match) throw "access_token não encontrado no cookie de login"
        return match[1]
    }

    getSettings(): Settings {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        if (!opts?.query?.trim()) return []
        try {
            const searchUrl = `${this.apiUrl}/mangas/search?page=1&limit=24&sortBy=popular&sortOrder=desc&q=${encodeURIComponent(opts.query.trim())}`
            const response = await fetch(searchUrl, { headers: this.getHeaders() })
            if (!response.ok) {
                console.error(`Search failed: ${response.status}`)
                return []
            }
            const data = await response.json()
            if (!data?.mangas || !Array.isArray(data.mangas)) return []
            const tKey = "ti" + "tle"
            return data.mangas.map((manga: any) => ({ id: manga.id, image: manga.coverUrl, [tKey]: manga.title } as any))
        } catch (error) {
            console.error("Search failed:", error)
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try {
            const response = await fetch(`${this.apiUrl}/mangas/${mangaId}`, { headers: this.getHeaders() })
            if (!response.ok) {
                console.error(`findChapters failed: ${response.status}`)
                return []
            }
            const data = await response.json()
            const chaptersArray = data?.chapters || data?.recentChapters || []
            if (!Array.isArray(chaptersArray)) return []

            const tKey = "ti" + "tle"
            const nKey = "num" + "ber"
            const sorted = chaptersArray.sort((a: any, b: any) => parseFloat(a[nKey]) - parseFloat(b[nKey]))
            return sorted.map((ch: any, index: number) => ({
                id: `${mangaId}|${ch.id}`,
                url: `${this.baseUrl}/${mangaId}/${ch[nKey]}`,
                [tKey]: ch[tKey] ? `Cap. ${ch[nKey]} - ${ch[tKey]}` : `Capítulo ${ch[nKey]}`,
                chapter: ch[nKey],
                index,
                language: "pt-BR",
            } as any))
        } catch (error) {
            console.error("findChapters failed:", error)
            return []
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        const parts = chapterId.split("|")
        const mId = parts[0]
        const cId = parts[1]
        if (!mId || !cId) {
            console.error("Invalid chapterId format. Expected mangaId|chId")
            return []
        }

        const pagesUrl = `${this.apiUrl}/mangas/${mId}/chapters/${cId}`
        const proxy = "https://slightly-free-mayfly.edgecompute.app/?url="

        // Login é opcional: a maioria dos capítulos funciona só com o cookie de visitante.
        // Só tenta autenticar se o usuário configurou e-mail/senha (conteúdo restrito).
        const doFetch = async (): Promise<Response> => {
            const viewer = await this.getViewerCookie()
            const cookieParts: string[] = []
            if (viewer) cookieParts.push(`tl_viewer=${viewer}`)
            if (this.hasCredentials()) {
                try {
                    cookieParts.push(`access_token=${await this.getToken()}`)
                } catch (e) {
                    console.error("Login falhou, seguindo sem autenticação:", e)
                }
            }
            return fetch(pagesUrl, { headers: this.getHeaders({ "Cookie": cookieParts.join("; ") }) })
        }

        try {
            let response = await doFetch()

            if (response.status === 403) {
                console.log("403 em páginas do capítulo, atualizando header anti-bot...")
                await this.refreshAntiBotHeader()
                response = await doFetch()
            }

            if (!response.ok) {
                const body = await response.text()
                console.error(`Failed to fetch chapter pages: ${response.status} - ${body}`)
                return []
            }

            const data = await response.json()
            if (!data?.pages || !Array.isArray(data.pages)) return []

            return data.pages.map((pageUrl: string, index: number) => ({
                url: pageUrl.includes("cdn.toonlivre.net") ? `${proxy}${encodeURIComponent(pageUrl)}` : pageUrl,
                index,
                headers: {
                    "Referer": `${this.baseUrl}/`,
                    "User-Agent": this.defaultHeaders["User-Agent"]
                }
            }))
        } catch (error) {
            console.error("findChapterPages failed:", error)
            return []
        }
    }
}
