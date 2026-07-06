/// <reference path="../../types/manga-provider.d.ts" />

class Provider {
    private baseUrl = "https://kuromangas.com"
    private apiUrl = "https://kuromangas.com/api"
    private cdnUrl = "https://cdn.kuromangas.com"
    
    // Constants for Decryption
    private VITE_API_ENC_KEY = "23ato8l674shksfE2oMmieshonuYTusF4jKdqEwhUEft9dsadcxzde3"
    private HOSTNAME_PART = "kuromangas.com::v2"
    private ANTIBOT = "x9_4v2_b"

    // Proteção CSRF é double-submit-cookie puro (servidor só compara Cookie vs header, sem estado
    // guardado). O valor real vem no Set-Cookie "kuro_x" do login, mas o Seanime só repassa o
    // primeiro Set-Cookie de respostas com múltiplos, então o segundo nunca chega ao JS. Como o
    // servidor aceita qualquer valor desde que Cookie e header sejam iguais, usamos uma constante fixa.
    private readonly csrfValue = "seanime-kuromangas-provider"

    getSettings(): Settings {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }

    private async requestAPI(url: string, options: any): Promise<any> {
        const res = await fetch(url, options);

        if (!res.ok) {
            const text = await res.text();
            throw `HTTP Error ${res.status}: ${text}`;
        }

        let dataKey = null;
        if (res.headers) {
            if (typeof res.headers.get === 'function') {
                dataKey = res.headers.get("x-kuro-datakey");
            } else {
                for (const key in res.headers) {
                    if (key.toLowerCase() === "x-kuro-datakey") {
                        const val = res.headers[key];
                        dataKey = Array.isArray(val) ? val[0] : val;
                        break;
                    }
                }
            }
        }

        if (dataKey) {
            const data = await res.json() as { _v_secure?: string; vSecure?: string };
            const encrypted = data._v_secure || data.vSecure || "";
            return this.decryptResponse(encrypted, dataKey);
        }

        return await res.json();
    }

    private async getToken(): Promise<string> {
        // userConfig fields are injected via {{email}} and {{password}}
        const email = "{{email}}";
        const password = "{{password}}";

        if (!email || !password || email.startsWith("{{") || password.startsWith("{{")) {
            throw "E-mail e senha são obrigatórios nas configurações do provedor.";
        }

        const payload = JSON.stringify({ email, password });

        try {
            const res = await fetch(`https://kuromangas.com/api/auth/login`, {
                method: "POST",
                headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json",
                    "Origin": this.baseUrl,
                    "Referer": `${this.baseUrl}/catalogo`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                body: payload
            });

            if (!res.ok) {
                const text = await res.text();
                throw `HTTP Error ${res.status}: ${text}`;
            }

            let setCookieStr = "";
            if (res.headers) {
                if (typeof res.headers.get === 'function') {
                    setCookieStr = res.headers.get("set-cookie") || res.headers.get("Set-Cookie") || "";
                } else {
                    for (const key in res.headers as any) {
                        if (key.toLowerCase() === "set-cookie") {
                            const val = (res.headers as any)[key];
                            setCookieStr = Array.isArray(val) ? val.join(";") : val;
                            break;
                        }
                    }
                }
            }

            const match = setCookieStr.match(/kuro_session=([^;]+)/);
            if (!match || !match[1]) {
                throw "Token kuro_session não extraído do cookie: " + setCookieStr;
            }

            return match[1];
        } catch (e: any) {
            throw "getToken error: " + e.toString();
        }
    }

    private async fetchApi(url: string): Promise<any> {
        try {
            const session = await this.getToken();

            return await this.requestAPI(url, {
                headers: {
                    // Proteção CSRF é double-submit-cookie puro: o servidor só compara este Cookie
                    // com o header X-Kuro-Verify, sem checar contra um valor emitido por ele (ver csrfValue acima).
                    "Cookie": `kuro_session=${session}; kuro_x=${this.csrfValue}`,
                    "X-Kuro-Verify": this.csrfValue,
                    "Accept": "application/json, text/plain, */*",
                    "Referer": `${this.baseUrl}/catalogo`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
            });
        } catch (e: any) {
            throw "fetchApi error: " + e.toString();
        }
    }

    private derivePassword(): string {
        const date = new Date().toISOString().split("T")[0]; // yyyy-mm-dd (UTC)
        const toHash = `${date}${this.HOSTNAME_PART}${this.ANTIBOT}`;
        
        const hashBytes = md5(toHash);
        const md5Hash = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        const md5Part = md5Hash.substring(0, 8);
        return this.VITE_API_ENC_KEY + md5Part;
    }

    private decryptResponse(vSecureBase64: string, dataKey: string): any {
        try {
            const password = this.derivePassword();
            const encryptedBytes = decodeBase64(vSecureBase64);
            
            // Skip "Salted__" (8 bytes)
            const salt = encryptedBytes.slice(8, 16);
            const ciphertext = encryptedBytes.slice(16);
            
            const passwordBytes = encodeUTF8(password);
            const { key, iv } = evpBytesToKey(passwordBytes, salt);
            
            const rabbit = new Rabbit();
            rabbit.setup(key, iv);
            rabbit.crypt(ciphertext); // modifies in place
            
            const decryptedStr = decodeUTF8(ciphertext);
            
            let wrapper;
            try {
                wrapper = JSON.parse(decryptedStr);
            } catch (e: any) {
                throw "JSON Parse error: " + e.toString() + ". Decrypted: " + decryptedStr.substring(0, 50);
            }
            
            let inner = wrapper[dataKey];
            if (!inner) {
                throw "Failed to decrypt API response. DataKey missing: " + dataKey;
            }
            if (typeof inner === "string") {
                try {
                    inner = JSON.parse(inner);
                } catch (e) {
                    // Ignore, it might be a plain string
                }
            }
            return inner;
        } catch (e: any) {
            throw "decryptResponse error: " + e.toString();
        }
    }

    async search(opts: QueryOptions): Promise<SearchResult[]> {
        let url = `${this.apiUrl}/mangas?page=1&limit=24`;
        if (opts.query && opts.query.trim() !== "") {
            url += `&search=${encodeURIComponent(opts.query)}`;
        } else {
            url += `&sort=view_count&order=DESC`; // popular
        }

        const response = await this.fetchApi(url);
        
        if (response?.error) {
            throw "API Error: " + response.error;
        }

        const items = response?.data ? response.data : (Array.isArray(response) ? response : []);

        return items.map((manga: any) => {
            const cover = manga.cover_image || manga.cover || "";
            const imageUrl = cover.startsWith("http") 
                ? cover 
                : `${this.cdnUrl}${cover.startsWith("/") ? "" : "/"}${cover}`;
            
            return {
                id: manga.id.toString(),
                title: manga.title,
                synonyms: manga.alternative_titles || (manga.slug ? [manga.slug] : []),
                year: manga.created_at ? new Date(manga.created_at).getFullYear() : 0,
                image: imageUrl
            };
        });
    }

    async findChapters(id: string): Promise<ChapterDetails[]> {
        const response = await this.fetchApi(`${this.apiUrl}/mangas/${id}`);
        // response has { manga: {...}, chapters: [...] }
        const chaptersList = response?.chapters ? response.chapters : (Array.isArray(response) ? response : []);

        const chapters: ChapterDetails[] = chaptersList.map((ch: any) => {
            const chNum = ch.chapter_number?.toString() || ch.number?.toString() || "";
            let title = ch.title || ch.name;
            if (!title) {
                title = `Capítulo ${chNum}`;
            }

            return {
                id: ch.id.toString(),
                url: `${this.apiUrl}/chapters/${ch.id}`,
                title: title,
                chapter: chNum,
                index: 0,
                updatedAt: ch.upload_date || ch.created_at
            };
        });

        // Sort ascending by chapter number as required by the provider documentation
        chapters.sort((a, b) => {
            const numA = parseFloat(a.chapter);
            const numB = parseFloat(b.chapter);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return 0;
        });

        // Assign correct index
        chapters.forEach((ch, i) => {
            ch.index = i;
        });

        return chapters;
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        // chapterId here is the API chapter ID from findChapters
        const response = await this.fetchApi(`${this.apiUrl}/chapters/${chapterId}`);
        // response structure: { pages: ["/uploads/...", ...] }
        const pagesList: string[] = response.pages || [];

        return pagesList.map((pageUrl, index) => {
            const fixedUrl = pageUrl.replace(/^\/uploads\//, "/");
            const imageUrl = fixedUrl.startsWith("http") 
                ? fixedUrl 
                : `${this.cdnUrl}${fixedUrl}`;
            
            return {
                url: imageUrl,
                index: index,
                headers: {
                    "Referer": `${this.baseUrl}/`
                }
            };
        });
    }
}

// ======================= CRYPTO UTILS =======================
function md5(str: string | Uint8Array): Uint8Array {
    let msg: Uint8Array = typeof str === 'string' ? encodeUTF8(str) : str;
    
    function leftRotate(x: number, c: number) {
        return (x << c) | (x >>> (32 - c));
    }
    
    let messageLen = msg.length;
    let numBlocks = Math.floor((messageLen + 8) / 64) + 1;
    let totalLen = numBlocks * 64;
    let padded = new Uint8Array(totalLen);
    padded.set(msg);
    padded[messageLen] = 0x80;
    let lengthBits = messageLen * 8;
    let view = new DataView(padded.buffer);
    view.setUint32(totalLen - 8, lengthBits, true);
    view.setUint32(totalLen - 4, Math.floor(lengthBits / 0x100000000), true);
    
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476;
    
    const k = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ];
    
    const r = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    
    for (let i = 0; i < totalLen; i += 64) {
        const w = new Int32Array(16);
        for (let j = 0; j < 16; j++) w[j] = view.getInt32(i + j * 4, true);
        
        let a = h0, b = h1, c = h2, d = h3;
        
        for (let j = 0; j < 64; j++) {
            let f, g;
            if (j < 16) { f = (b & c) | ((~b) & d); g = j; }
            else if (j < 32) { f = (d & b) | ((~d) & c); g = (5 * j + 1) % 16; }
            else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
            else { f = c ^ (b | (~d)); g = (7 * j) % 16; }
            
            let temp = d;
            d = c;
            c = b;
            b = (b + leftRotate((a + f + k[j] + w[g]) | 0, r[j])) | 0;
            a = temp;
        }
        
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    }
    
    let res = new Uint8Array(16);
    let outView = new DataView(res.buffer);
    outView.setInt32(0, h0, true); outView.setInt32(4, h1, true);
    outView.setInt32(8, h2, true); outView.setInt32(12, h3, true);
    return res;
}

function decodeBase64(base64: string): Uint8Array {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = new Uint8Array(256);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
    let bufferLength = base64.length * 0.75;
    if (base64[base64.length - 1] === "=") bufferLength--;
    if (base64[base64.length - 2] === "=") bufferLength--;
    const bytes = new Uint8Array(bufferLength);
    let p = 0;
    for (let i = 0; i < base64.length; i += 4) {
        let enc1 = lookup[base64.charCodeAt(i)], enc2 = lookup[base64.charCodeAt(i + 1)];
        let enc3 = lookup[base64.charCodeAt(i + 2)], enc4 = lookup[base64.charCodeAt(i + 3)];
        bytes[p++] = (enc1 << 2) | (enc2 >> 4);
        if (enc3 !== undefined && base64.charCodeAt(i + 2) !== 61) bytes[p++] = ((enc2 & 15) << 4) | (enc3 >> 2);
        if (enc4 !== undefined && base64.charCodeAt(i + 3) !== 61) bytes[p++] = ((enc3 & 3) << 6) | (enc4 & 63);
    }
    return bytes;
}

function encodeUTF8(str: string): Uint8Array {
    const arr = [];
    for (let i = 0; i < str.length; i++) {
        let charcode = str.charCodeAt(i);
        if (charcode < 0x80) arr.push(charcode);
        else if (charcode < 0x800) arr.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
        else if (charcode < 0xd800 || charcode >= 0xe000) arr.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
        else {
            i++;
            charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
            arr.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
        }
    }
    return new Uint8Array(arr);
}

function decodeUTF8(bytes: Uint8Array): string {
    let out = "", i = 0;
    while (i < bytes.length) {
        let c = bytes[i++];
        if (c < 0x80) out += String.fromCharCode(c);
        else if (c > 0xbf && c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
        else if (c > 0xdf && c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        else {
            let c2 = bytes[i++], c3 = bytes[i++], c4 = bytes[i++];
            let u = (((c & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f)) - 0x10000;
            out += String.fromCharCode(0xd800 | (u >> 10), 0xdc00 | (u & 0x3ff));
        }
    }
    return out;
}

function evpBytesToKey(password: Uint8Array, salt: Uint8Array, keyLen = 16, ivLen = 8) {
    const derived = new Uint8Array(keyLen + ivLen);
    let derivedPos = 0;
    let md5Hash = new Uint8Array(0);
    while (derivedPos < derived.length) {
        let input = new Uint8Array(md5Hash.length + password.length + salt.length);
        input.set(md5Hash, 0); input.set(password, md5Hash.length); input.set(salt, md5Hash.length + password.length);
        md5Hash = md5(input);
        let toCopy = Math.min(md5Hash.length, derived.length - derivedPos);
        derived.set(md5Hash.slice(0, toCopy), derivedPos);
        derivedPos += toCopy;
    }
    return { key: derived.slice(0, keyLen), iv: derived.slice(keyLen, keyLen + ivLen) };
}

class Rabbit {
    x = new Int32Array(8); c = new Int32Array(8); b = 0;
    setup(key: Uint8Array, iv: Uint8Array) {
        const kw = new Int32Array(4);
        for (let i = 0; i < 4; i++) kw[i] = (key[i * 4 + 3] << 24) | (key[i * 4 + 2] << 16) | (key[i * 4 + 1] << 8) | (key[i * 4]);
        this.x[0] = kw[0]; this.x[1] = (kw[3] << 16) | ((kw[2] >>> 16) & 0xFFFF);
        this.x[2] = kw[1]; this.x[3] = (kw[0] << 16) | ((kw[3] >>> 16) & 0xFFFF);
        this.x[4] = kw[2]; this.x[5] = (kw[1] << 16) | ((kw[0] >>> 16) & 0xFFFF);
        this.x[6] = kw[3]; this.x[7] = (kw[2] << 16) | ((kw[1] >>> 16) & 0xFFFF);
        this.c[0] = (kw[2] << 16) | ((kw[2] >>> 16) & 0xFFFF); this.c[1] = (kw[0] & 0xFFFF0000) | (kw[1] & 0xFFFF);
        this.c[2] = (kw[3] << 16) | ((kw[3] >>> 16) & 0xFFFF); this.c[3] = (kw[1] & 0xFFFF0000) | (kw[2] & 0xFFFF);
        this.c[4] = (kw[0] << 16) | ((kw[0] >>> 16) & 0xFFFF); this.c[5] = (kw[2] & 0xFFFF0000) | (kw[3] & 0xFFFF);
        this.c[6] = (kw[1] << 16) | ((kw[1] >>> 16) & 0xFFFF); this.c[7] = (kw[3] & 0xFFFF0000) | (kw[0] & 0xFFFF);
        this.b = 0;
        for (let i = 0; i < 4; i++) this.nextState();
        for (let i = 0; i < 8; i++) this.c[i] ^= this.x[(i + 4) & 7];
        if (iv.length > 0) {
            const iv0 = (iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3];
            const iv1 = (iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7];
            const swap = (w: number) => ((w & 0xFF) << 24) | ((w & 0xFF00) << 8) | ((w & 0xFF0000) >>> 8) | ((w >>> 24) & 0xFF);
            const i0 = swap(iv0), i2 = swap(iv1), i1 = (i0 >>> 16) | (i2 & 0xFFFF0000), i3 = ((i2 << 16) | (i0 & 0x0000FFFF));
            this.c[0] ^= i0; this.c[1] ^= i1; this.c[2] ^= i2; this.c[3] ^= i3;
            this.c[4] ^= i0; this.c[5] ^= i1; this.c[6] ^= i2; this.c[7] ^= i3;
            for (let i = 0; i < 4; i++) this.nextState();
        }
    }
    crypt(data: Uint8Array) {
        const wordsSize = Math.floor((data.length + 3) / 4);
        const words = new Int32Array(wordsSize);
        for (let i = 0; i < wordsSize; i++) {
            let word = 0;
            for (let j = 0; j < 4; j++) {
                const byteIdx = i * 4 + j;
                if (byteIdx < data.length) word |= (data[byteIdx] & 0xFF) << (j * 8);
            }
            words[i] = word;
        }
        let idx = 0;
        while (idx < words.length) {
            this.nextState();
            const { s0, s1, s2, s3 } = this.keystreamBlock();
            if (idx < words.length) words[idx] ^= s0;
            if (idx + 1 < words.length) words[idx + 1] ^= s1;
            if (idx + 2 < words.length) words[idx + 2] ^= s2;
            if (idx + 3 < words.length) words[idx + 3] ^= s3;
            idx += 4;
        }
        for (let byteIdx = 0; byteIdx < data.length; byteIdx++) {
            const wordIdx = Math.floor(byteIdx / 4);
            data[byteIdx] = (words[wordIdx] >>> ((byteIdx % 4) * 8)) & 0xFF;
        }
    }
    keystreamBlock() {
        const s0 = (this.x[0] ^ (this.x[5] >>> 16) ^ (this.x[3] << 16)) | 0;
        const s1 = (this.x[2] ^ (this.x[7] >>> 16) ^ (this.x[5] << 16)) | 0;
        const s2 = (this.x[4] ^ (this.x[1] >>> 16) ^ (this.x[7] << 16)) | 0;
        const s3 = (this.x[6] ^ (this.x[3] >>> 16) ^ (this.x[1] << 16)) | 0;
        return { s0, s1, s2, s3 };
    }
    nextState() {
        const cOld = new Int32Array(this.c);
        const unsignedLessThan = (a: number, b: number) => (a >>> 0) < (b >>> 0);
        this.c[0] = (this.c[0] + 0x4D34D34D + this.b) | 0;
        this.c[1] = (this.c[1] + 0xD34D34D3 + (unsignedLessThan(this.c[0], cOld[0]) ? 1 : 0)) | 0;
        this.c[2] = (this.c[2] + 0x34D34D34 + (unsignedLessThan(this.c[1], cOld[1]) ? 1 : 0)) | 0;
        this.c[3] = (this.c[3] + 0x4D34D34D + (unsignedLessThan(this.c[2], cOld[2]) ? 1 : 0)) | 0;
        this.c[4] = (this.c[4] + 0xD34D34D3 + (unsignedLessThan(this.c[3], cOld[3]) ? 1 : 0)) | 0;
        this.c[5] = (this.c[5] + 0x34D34D34 + (unsignedLessThan(this.c[4], cOld[4]) ? 1 : 0)) | 0;
        this.c[6] = (this.c[6] + 0x4D34D34D + (unsignedLessThan(this.c[5], cOld[5]) ? 1 : 0)) | 0;
        this.c[7] = (this.c[7] + 0xD34D34D3 + (unsignedLessThan(this.c[6], cOld[6]) ? 1 : 0)) | 0;
        this.b = unsignedLessThan(this.c[7], cOld[7]) ? 1 : 0;
        const g = new Int32Array(8);
        for (let i = 0; i < 8; i++) {
            const gx = (this.x[i] + this.c[i]) | 0;
            const ga = gx & 0xFFFF, gb = (gx >>> 16) & 0xFFFF;
            const gh = ((((ga * ga) >>> 17) + ga * gb) >>> 15) + gb * gb;
            g[i] = (gh ^ Math.imul(gx, gx)) | 0;
        }
        this.x[0] = (g[0] + ((g[7] << 16) | (g[7] >>> 16)) + ((g[6] << 16) | (g[6] >>> 16))) | 0;
        this.x[1] = (g[1] + ((g[0] << 8) | (g[0] >>> 24)) + g[7]) | 0;
        this.x[2] = (g[2] + ((g[1] << 16) | (g[1] >>> 16)) + ((g[0] << 16) | (g[0] >>> 16))) | 0;
        this.x[3] = (g[3] + ((g[2] << 8) | (g[2] >>> 24)) + g[1]) | 0;
        this.x[4] = (g[4] + ((g[3] << 16) | (g[3] >>> 16)) + ((g[2] << 16) | (g[2] >>> 16))) | 0;
        this.x[5] = (g[5] + ((g[4] << 8) | (g[4] >>> 24)) + g[3]) | 0;
        this.x[6] = (g[6] + ((g[5] << 16) | (g[5] >>> 16)) + ((g[4] << 16) | (g[4] >>> 16))) | 0;
        this.x[7] = (g[7] + ((g[6] << 8) | (g[6] >>> 24)) + g[5]) | 0;
    }
}
