import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";

// Upload file to S3 bucket
async function uploadToS3(filePath: string, bucketName: string, key: string) {
  // Create S3 client using credentials from ~/.aws/credentials (Railway will inject these)
  const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: fromIni({ profileName: process.env.AWS_PROFILE || 'default' }),
  });

  try {
    // Read file content
    const fileContent = fs.readFileSync(filePath);
    
    // Create upload command
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileContent,
      ContentType: getContentType(filePath),
    });
    
    // Upload file
    const response = await s3Client.send(command);
    console.log(`Successfully uploaded ${filePath} to S3 bucket: ${bucketName}, key: ${key}`);
    return response;
  } catch (error) {
    console.error('Failed to upload to S3:', error);
    throw error;
  }
}

// Helper function to get content type based on file extension
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  
  switch (ext) {
    case '.torrent': return 'application/x-bittorrent';
    case '.json': return 'application/json';
    case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.xml': return 'application/xml';
    default: return 'application/octet-stream';
  }
}

// Main function
async function main() {
  // Get environment variables
  const bucketName = process.env.S3_BUCKET_NAME;
  const localFilePath = process.env.LOCAL_FILE_PATH;
  const s3Key = process.env.S3_KEY || path.basename(localFilePath);
  
  if (!bucketName) {
    console.error('S3_BUCKET_NAME environment variable is not set');
    process.exit(1);
  }
  
  if (!localFilePath) {
    console.error('LOCAL_FILE_PATH environment variable is not set');
    process.exit(1);
  }
  
  try {
    await uploadToS3(localFilePath, bucketName, s3Key);
    console.log('Upload completed successfully');
  } catch (error) {
    console.error('Error uploading to S3:', error);
    process.exit(1);
  }
}

if (process.argv.includes('--run')) {
  main().catch(console.error);
}

export { uploadToS3 };