terraform {
  required_version = ">= 1.10" # S3 native state locking (use_lockfile)

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
  }

  # State: a versioned, encrypted S3 bucket the owner creates once (README, apply order step 1):
  #   tofu init -backend-config="bucket=<state bucket>" -backend-config="region=<region>"
  backend "s3" {
    key          = "oryxa-fde/dev/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  # Refuse to run against any account but the one named in tfvars.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      project = "oryxa-fde"
      env     = var.env
    }
  }
}

# Token comes from CLOUDFLARE_API_TOKEN in the environment, never from a file.
provider "cloudflare" {}
