// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

interface BookMetadata {
  title: string;
  author: string;
  language: string;
  originalFilename: string;
  side: 'foreign' | 'native';
}

interface EpubContent {
  metadata: any;
  structure: any;
  chapters: any[];
  resources: any;
  parsing: any;
}

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    });
  }

  try {
    // Get Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const body = await req.json();
    const { 
      metadata,
      epubPath,
      epubContent,
      ownerId,
      visibility = 'private'
    } = body;
    
    if (!metadata || !epubPath || !ownerId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: metadata, epubPath, ownerId' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    console.log(`Creating ${metadata.side} book record:`);
    console.log(`  - Title: ${metadata.title}`);
    console.log(`  - Author: ${metadata.author}`);
    console.log(`  - Language: ${metadata.language}`);
    console.log(`  - EPUB Path: ${epubPath}`);
    console.log(`  - Parsed Content: ${epubContent ? 'YES - storing in json_blob' : 'NO - json_blob will be null'}`);
    
    if (epubContent) {
      console.log(`  - Cover Image: ${epubContent.resources?.coverImage ? 'Found and stored in cover_url' : 'Not found'}`);
      console.log(`  - JSON Blob Size: ~${JSON.stringify(epubContent).length} characters`);
      console.log(`  - Chapters: ${epubContent.structure?.totalChapters || 0}`);
      console.log(`  - Words: ${epubContent.structure?.wordCount || 0}`);
      console.log(`  - Reading Time: ${epubContent.structure?.estimatedReadingTime || 0} minutes`);
    }

    const bookData = {
      owner_id: ownerId,
      visibility: visibility as 'public' | 'private',
      language_code: metadata.language || 'en',
      side: metadata.side,
      title: metadata.title || metadata.originalFilename.replace('.epub', ''),
      author: metadata.author || '',
      epub_path: epubPath,
      published_on: epubContent?.metadata?.publishedDate || null,
      cover_url: epubContent?.resources?.coverImage || null,
      json_blob: epubContent || null, // Store parsed EPUB content in json_blob field
      is_deleted: false
    };

    const createStartTime = Date.now();
    const { data, error } = await supabase
      .from('books')
      .insert(bookData)
      .select()
      .single();
    
    const createTime = Date.now() - createStartTime;

    if (error) {
      console.error('Book creation error:', error);
      throw new Error(`Book creation failed: ${error.message}`);
    }

    console.log(`Successfully created book record: ${data.id} in ${createTime}ms`);

    // Calculate statistics
    const stats = {
      hasContent: !!epubContent,
      chapters: epubContent?.structure?.totalChapters || 0,
      words: epubContent?.structure?.wordCount || 0,
      readingTime: epubContent?.structure?.estimatedReadingTime || 0,
      images: epubContent?.resources?.images?.length || 0,
      stylesheets: epubContent?.resources?.stylesheets?.length || 0,
      fonts: epubContent?.resources?.fonts?.length || 0,
      parsingErrors: epubContent?.parsing?.errors?.length || 0,
      parsingWarnings: epubContent?.parsing?.warnings?.length || 0
    };

    return new Response(
      JSON.stringify({
        success: true,
        book: {
          id: data.id,
          title: data.title,
          author: data.author,
          side: data.side,
          language_code: data.language_code,
          visibility: data.visibility,
          epub_path: data.epub_path,
          cover_url: data.cover_url,
          created_at: data.created_at
        },
        stats: stats,
        createTime: createTime,
        contentParsed: !!epubContent
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );

  } catch (error) {
    console.error('Error in create-book-record function:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Book record creation failed',
        hint: 'Check database permissions and ensure all required fields are provided'
      }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
});
